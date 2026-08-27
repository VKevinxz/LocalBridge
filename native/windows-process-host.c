#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <iphlpapi.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>

/*
 * Host mínimo para procesos persistentes de LocalBridge en Windows.
 *
 * El proceso objetivo se crea suspendido, se incorpora a un Job Object con
 * KILL_ON_JOB_CLOSE y solo entonces empieza a ejecutar. El host espera tanto
 * al objetivo como al proceso Electron que lo creó: si cualquiera desaparece,
 * cerrar el Job Object elimina el árbol completo.
 */

#define EXIT_USAGE 64
#define EXIT_SETUP 70
#define EXIT_PARENT_GONE 71
#define MAX_COMMAND_LINE_CHARS 32767
#define CONTROL_FD 3
#define MAX_JOB_PIDS 256
#define MAX_LISTENERS 128
#define LISTENER_POLL_MS 250

typedef struct {
  DWORD number_of_assigned_processes;
  DWORD number_of_process_ids_in_list;
  ULONG_PTR process_ids[MAX_JOB_PIDS];
} job_pid_buffer;

typedef struct {
  USHORT family;
  USHORT port;
  DWORD owner_pid;
  bool wildcard;
  bool exclusive;
} listener_entry;

typedef struct {
  HANDLE job;
  HANDLE stop_event;
} listener_monitor_context;

typedef struct {
  HANDLE source;
  HANDLE destination;
} pipe_pump_context;

static DWORD WINAPI pump_pipe(LPVOID parameter) {
  pipe_pump_context *context = parameter;
  BYTE buffer[4096];
  DWORD read_bytes = 0;
  while (ReadFile(context->source, buffer, sizeof(buffer), &read_bytes, NULL) && read_bytes > 0) {
    DWORD offset = 0;
    while (offset < read_bytes) {
      DWORD written = 0;
      if (!WriteFile(context->destination, buffer + offset, read_bytes - offset, &written, NULL) || written == 0) return 0;
      offset += written;
    }
  }
  return 0;
}

static DWORD WINAPI pump_stdin_to_pty(LPVOID parameter) {
  pipe_pump_context *context = parameter;
  BYTE buffer[4096];
  _setmode(_fileno(stdin), _O_BINARY);
  while (true) {
    const int read_bytes = _read(_fileno(stdin), buffer, sizeof(buffer));
    if (read_bytes <= 0) return 0;
    DWORD offset = 0;
    while (offset < (DWORD)read_bytes) {
      DWORD written = 0;
      if (!WriteFile(context->destination, buffer + offset, (DWORD)read_bytes - offset, &written, NULL) || written == 0) return 0;
      offset += written;
    }
  }
}

static bool pid_in_list(DWORD pid, const DWORD *pids, size_t count) {
  for (size_t index = 0; index < count; index += 1) {
    if (pids[index] == pid) return true;
  }
  return false;
}

static bool query_job_pids(HANDLE job, DWORD *pids, size_t *count) {
  job_pid_buffer buffer;
  ZeroMemory(&buffer, sizeof(buffer));
  if (!QueryInformationJobObject(
        job,
        JobObjectBasicProcessIdList,
        &buffer,
        sizeof(buffer),
        NULL)) {
    return false;
  }
  if (buffer.number_of_assigned_processes > buffer.number_of_process_ids_in_list ||
      buffer.number_of_process_ids_in_list > MAX_JOB_PIDS) {
    return false;
  }
  *count = buffer.number_of_process_ids_in_list;
  for (size_t index = 0; index < *count; index += 1) {
    const ULONG_PTR value = buffer.process_ids[index];
    if (value == 0 || value > UINT32_MAX) return false;
    pids[index] = (DWORD)value;
  }
  return true;
}

static void add_listener(
  listener_entry *listeners,
  size_t *count,
  USHORT family,
  USHORT port,
  DWORD owner_pid,
  bool wildcard,
  const DWORD *before,
  size_t before_count) {
  if (port == 0 || *count >= MAX_LISTENERS || !pid_in_list(owner_pid, before, before_count)) return;
  for (size_t index = 0; index < *count; index += 1) {
    if (listeners[index].family == family && listeners[index].port == port &&
        listeners[index].wildcard == wildcard) return;
  }
  listeners[*count].family = family;
  listeners[*count].port = port;
  listeners[*count].owner_pid = owner_pid;
  listeners[*count].wildcard = wildcard;
  listeners[*count].exclusive = true;
  *count += 1;
}

static void collect_ipv4_listeners(
  listener_entry *listeners,
  size_t *count,
  const DWORD *before,
  size_t before_count) {
  DWORD bytes = 0;
  DWORD status = GetExtendedTcpTable(NULL, &bytes, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
  if (status != ERROR_INSUFFICIENT_BUFFER || bytes == 0) return;
  PMIB_TCPTABLE_OWNER_PID table = malloc(bytes);
  if (table == NULL) return;
  status = GetExtendedTcpTable(table, &bytes, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
  if (status == NO_ERROR) {
    for (DWORD index = 0; index < table->dwNumEntries; index += 1) {
      const MIB_TCPROW_OWNER_PID row = table->table[index];
      if (row.dwLocalAddr == htonl(INADDR_LOOPBACK) || row.dwLocalAddr == htonl(INADDR_ANY)) {
        add_listener(
          listeners,
          count,
          4,
          ntohs((USHORT)row.dwLocalPort),
          row.dwOwningPid,
          row.dwLocalAddr == htonl(INADDR_ANY),
          before,
          before_count);
      }
    }
  }
  free(table);
}

static void collect_ipv6_listeners(
  listener_entry *listeners,
  size_t *count,
  const DWORD *before,
  size_t before_count) {
  static const UCHAR loopback[16] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
  DWORD bytes = 0;
  DWORD status = GetExtendedTcpTable(NULL, &bytes, FALSE, AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, 0);
  if (status != ERROR_INSUFFICIENT_BUFFER || bytes == 0) return;
  PMIB_TCP6TABLE_OWNER_PID table = malloc(bytes);
  if (table == NULL) return;
  status = GetExtendedTcpTable(table, &bytes, FALSE, AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, 0);
  if (status == NO_ERROR) {
    for (DWORD index = 0; index < table->dwNumEntries; index += 1) {
      const MIB_TCP6ROW_OWNER_PID row = table->table[index];
      static const UCHAR wildcard[16] = {0};
      if (memcmp(row.ucLocalAddr, loopback, sizeof(loopback)) == 0 ||
          memcmp(row.ucLocalAddr, wildcard, sizeof(wildcard)) == 0) {
        add_listener(
          listeners,
          count,
          6,
          ntohs((USHORT)row.dwLocalPort),
          row.dwOwningPid,
          memcmp(row.ucLocalAddr, wildcard, sizeof(wildcard)) == 0,
          before,
          before_count);
      }
    }
  }
  free(table);
}

/*
 * Un origen localhost es adoptable solo si ninguna entrada loopback/wildcard
 * compatible del mismo puerto pertenece a un proceso fuera del Job. La
 * comprobación es deliberadamente conservadora entre IPv4 e IPv6: Chromium
 * puede resolver localhost a cualquiera de las dos familias.
 */
static void mark_external_conflicts_ipv4(
  listener_entry *listeners,
  size_t count,
  const DWORD *job_pids,
  size_t job_pid_count) {
  DWORD bytes = 0;
  DWORD status = GetExtendedTcpTable(NULL, &bytes, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
  if (status != ERROR_INSUFFICIENT_BUFFER || bytes == 0) {
    for (size_t index = 0; index < count; index += 1) listeners[index].exclusive = false;
    return;
  }
  PMIB_TCPTABLE_OWNER_PID table = malloc(bytes);
  if (table == NULL) {
    for (size_t index = 0; index < count; index += 1) listeners[index].exclusive = false;
    return;
  }
  status = GetExtendedTcpTable(table, &bytes, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
  if (status != NO_ERROR) {
    for (size_t index = 0; index < count; index += 1) listeners[index].exclusive = false;
    free(table);
    return;
  }
  for (DWORD row_index = 0; row_index < table->dwNumEntries; row_index += 1) {
    const MIB_TCPROW_OWNER_PID row = table->table[row_index];
    if (pid_in_list(row.dwOwningPid, job_pids, job_pid_count)) continue;
    if (row.dwLocalAddr != htonl(INADDR_LOOPBACK) && row.dwLocalAddr != htonl(INADDR_ANY)) continue;
    const USHORT port = ntohs((USHORT)row.dwLocalPort);
    for (size_t index = 0; index < count; index += 1) {
      if (listeners[index].port == port) listeners[index].exclusive = false;
    }
  }
  free(table);
}

static void mark_external_conflicts_ipv6(
  listener_entry *listeners,
  size_t count,
  const DWORD *job_pids,
  size_t job_pid_count) {
  static const UCHAR loopback[16] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
  static const UCHAR wildcard[16] = {0};
  DWORD bytes = 0;
  DWORD status = GetExtendedTcpTable(NULL, &bytes, FALSE, AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, 0);
  if (status != ERROR_INSUFFICIENT_BUFFER || bytes == 0) {
    for (size_t index = 0; index < count; index += 1) listeners[index].exclusive = false;
    return;
  }
  PMIB_TCP6TABLE_OWNER_PID table = malloc(bytes);
  if (table == NULL) {
    for (size_t index = 0; index < count; index += 1) listeners[index].exclusive = false;
    return;
  }
  status = GetExtendedTcpTable(table, &bytes, FALSE, AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, 0);
  if (status != NO_ERROR) {
    for (size_t index = 0; index < count; index += 1) listeners[index].exclusive = false;
    free(table);
    return;
  }
  for (DWORD row_index = 0; row_index < table->dwNumEntries; row_index += 1) {
    const MIB_TCP6ROW_OWNER_PID row = table->table[row_index];
    if (pid_in_list(row.dwOwningPid, job_pids, job_pid_count)) continue;
    if (memcmp(row.ucLocalAddr, loopback, sizeof(loopback)) != 0 &&
        memcmp(row.ucLocalAddr, wildcard, sizeof(wildcard)) != 0) continue;
    const USHORT port = ntohs((USHORT)row.dwLocalPort);
    for (size_t index = 0; index < count; index += 1) {
      if (listeners[index].port == port) listeners[index].exclusive = false;
    }
  }
  free(table);
}

static int compare_listeners(const void *left_value, const void *right_value) {
  const listener_entry *left = left_value;
  const listener_entry *right = right_value;
  if (left->family != right->family) return left->family < right->family ? -1 : 1;
  if (left->port == right->port) return 0;
  return left->port < right->port ? -1 : 1;
}

static bool write_listener_snapshot(HANDLE job) {
  DWORD before[MAX_JOB_PIDS];
  DWORD after[MAX_JOB_PIDS];
  size_t before_count = 0;
  size_t after_count = 0;
  listener_entry listeners[MAX_LISTENERS];
  size_t listener_count = 0;
  if (!query_job_pids(job, before, &before_count)) return true;
  collect_ipv4_listeners(listeners, &listener_count, before, before_count);
  collect_ipv6_listeners(listeners, &listener_count, before, before_count);
  if (!query_job_pids(job, after, &after_count)) listener_count = 0;

  size_t write_index = 0;
  for (size_t read_index = 0; read_index < listener_count; read_index += 1) {
    if (pid_in_list(listeners[read_index].owner_pid, after, after_count)) {
      listeners[write_index++] = listeners[read_index];
    }
  }
  listener_count = write_index;
  mark_external_conflicts_ipv4(listeners, listener_count, after, after_count);
  mark_external_conflicts_ipv6(listeners, listener_count, after, after_count);
  qsort(listeners, listener_count, sizeof(listener_entry), compare_listeners);

  char line[4096];
  int used = snprintf(line, sizeof(line), "LBP2 %zu", listener_count);
  if (used < 0 || (size_t)used >= sizeof(line)) return false;
  for (size_t index = 0; index < listener_count; index += 1) {
    const int appended = snprintf(
      line + used,
      sizeof(line) - (size_t)used,
      " %u%c:%u:%u",
      (unsigned int)listeners[index].family,
      listeners[index].wildcard ? 'w' : 'l',
      (unsigned int)listeners[index].port,
      listeners[index].exclusive ? 1U : 0U);
    if (appended < 0 || (size_t)appended >= sizeof(line) - (size_t)used) return false;
    used += appended;
  }
  if ((size_t)used + 1 >= sizeof(line)) return false;
  line[used++] = '\n';
  return _write(CONTROL_FD, line, (unsigned int)used) == used;
}

static DWORD WINAPI monitor_listeners(LPVOID parameter) {
  listener_monitor_context *context = parameter;
  while (true) {
    if (!write_listener_snapshot(context->job)) return 0;
    if (WaitForSingleObject(context->stop_event, LISTENER_POLL_MS) != WAIT_TIMEOUT) return 0;
  }
}

static bool append_char(wchar_t *buffer, size_t capacity, size_t *length, wchar_t value) {
  if (*length + 1 >= capacity) return false;
  buffer[(*length)++] = value;
  buffer[*length] = L'\0';
  return true;
}

static bool append_repeated(wchar_t *buffer, size_t capacity, size_t *length, wchar_t value, size_t count) {
  for (size_t index = 0; index < count; index += 1) {
    if (!append_char(buffer, capacity, length, value)) return false;
  }
  return true;
}

/* Quote compatible con CommandLineToArgvW / runtime C de Windows. */
static bool append_quoted_arg(wchar_t *buffer, size_t capacity, size_t *length, const wchar_t *arg) {
  const bool needs_quotes = arg[0] == L'\0' || wcspbrk(arg, L" \t\n\v\"") != NULL;
  if (!needs_quotes) {
    while (*arg != L'\0') {
      if (!append_char(buffer, capacity, length, *arg++)) return false;
    }
    return true;
  }

  if (!append_char(buffer, capacity, length, L'\"')) return false;
  size_t backslashes = 0;
  for (const wchar_t *cursor = arg;; cursor += 1) {
    if (*cursor == L'\\') {
      backslashes += 1;
      continue;
    }
    if (*cursor == L'\"') {
      if (!append_repeated(buffer, capacity, length, L'\\', backslashes * 2 + 1)) return false;
      if (!append_char(buffer, capacity, length, L'\"')) return false;
      backslashes = 0;
      continue;
    }
    if (*cursor == L'\0') {
      if (!append_repeated(buffer, capacity, length, L'\\', backslashes * 2)) return false;
      break;
    }
    if (!append_repeated(buffer, capacity, length, L'\\', backslashes)) return false;
    backslashes = 0;
    if (!append_char(buffer, capacity, length, *cursor)) return false;
  }
  return append_char(buffer, capacity, length, L'\"');
}

static wchar_t *build_command_line(int argc, wchar_t **argv, int first_arg) {
  wchar_t *buffer = calloc(MAX_COMMAND_LINE_CHARS, sizeof(wchar_t));
  if (buffer == NULL) return NULL;
  size_t length = 0;

  for (int index = first_arg; index < argc; index += 1) {
    if (index > first_arg && !append_char(buffer, MAX_COMMAND_LINE_CHARS, &length, L' ')) {
      free(buffer);
      return NULL;
    }
    if (!append_quoted_arg(buffer, MAX_COMMAND_LINE_CHARS, &length, argv[index])) {
      free(buffer);
      return NULL;
    }
  }
  return buffer;
}

static void print_win32_error(const wchar_t *stage) {
  fwprintf(stderr, L"localbridge-process-host: %ls failed (%lu)\n", stage, GetLastError());
}

int wmain(int argc, wchar_t **argv) {
  const bool pty_mode = argc >= 6 && wcscmp(argv[3], L"--pty") == 0 && wcscmp(argv[4], L"--") == 0;
  const int command_index = pty_mode ? 5 : 4;
  if (argc <= command_index || wcscmp(argv[1], L"--parent") != 0 ||
      (!pty_mode && wcscmp(argv[3], L"--") != 0)) {
    fwprintf(stderr, L"usage: localbridge-process-host --parent <pid> [--pty] -- <command> [args...]\n");
    return EXIT_USAGE;
  }

  wchar_t *pid_end = NULL;
  const unsigned long parsed_pid = wcstoul(argv[2], &pid_end, 10);
  if (parsed_pid == 0 || pid_end == NULL || *pid_end != L'\0' || parsed_pid > UINT32_MAX) {
    fwprintf(stderr, L"localbridge-process-host: invalid parent pid\n");
    return EXIT_USAGE;
  }

  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)parsed_pid);
  if (parent == NULL) {
    print_win32_error(L"OpenProcess(parent)");
    return EXIT_PARENT_GONE;
  }

  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) {
    print_win32_error(L"CreateJobObject");
    CloseHandle(parent);
    return EXIT_SETUP;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    print_win32_error(L"SetInformationJobObject");
    CloseHandle(job);
    CloseHandle(parent);
    return EXIT_SETUP;
  }

  wchar_t *command_line = build_command_line(argc, argv, command_index);
  if (command_line == NULL) {
    fwprintf(stderr, L"localbridge-process-host: command line is too large\n");
    CloseHandle(job);
    CloseHandle(parent);
    return EXIT_USAGE;
  }

  HANDLE std_handles[3] = {
    GetStdHandle(STD_INPUT_HANDLE),
    GetStdHandle(STD_OUTPUT_HANDLE),
    GetStdHandle(STD_ERROR_HANDLE),
  };
  for (size_t index = 0; !pty_mode && index < 3; index += 1) {
    if (std_handles[index] != NULL && std_handles[index] != INVALID_HANDLE_VALUE) {
      SetHandleInformation(std_handles[index], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }
  }

  HPCON pseudo_console = NULL;
  HANDLE pty_input_read = NULL;
  HANDLE pty_input_write = NULL;
  HANDLE pty_output_read = NULL;
  HANDLE pty_output_write = NULL;
  HANDLE input_pump = NULL;
  HANDLE output_pump = NULL;
  pipe_pump_context input_context;
  pipe_pump_context output_context;
  ZeroMemory(&input_context, sizeof(input_context));
  ZeroMemory(&output_context, sizeof(output_context));

  if (pty_mode) {
    SECURITY_ATTRIBUTES pipe_security;
    ZeroMemory(&pipe_security, sizeof(pipe_security));
    pipe_security.nLength = sizeof(pipe_security);
    pipe_security.bInheritHandle = TRUE;
    if (!CreatePipe(&pty_input_read, &pty_input_write, &pipe_security, 0) ||
        !CreatePipe(&pty_output_read, &pty_output_write, &pipe_security, 0)) {
      print_win32_error(L"CreatePipe(pty)");
      if (pty_input_read != NULL) CloseHandle(pty_input_read);
      if (pty_input_write != NULL) CloseHandle(pty_input_write);
      if (pty_output_read != NULL) CloseHandle(pty_output_read);
      if (pty_output_write != NULL) CloseHandle(pty_output_write);
      free(command_line);
      CloseHandle(job);
      CloseHandle(parent);
      return EXIT_SETUP;
    }
    SetHandleInformation(pty_input_write, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(pty_output_read, HANDLE_FLAG_INHERIT, 0);
    COORD size = {120, 40};
    const HRESULT pty_result = CreatePseudoConsole(size, pty_input_read, pty_output_write, 0, &pseudo_console);
    if (FAILED(pty_result)) {
      fwprintf(stderr, L"localbridge-process-host: CreatePseudoConsole failed (0x%08lx)\n", (unsigned long)pty_result);
      CloseHandle(pty_input_read);
      CloseHandle(pty_input_write);
      CloseHandle(pty_output_read);
      CloseHandle(pty_output_write);
      free(command_line);
      CloseHandle(job);
      CloseHandle(parent);
      return EXIT_SETUP;
    }
    CloseHandle(pty_input_read);
    pty_input_read = NULL;
    CloseHandle(pty_output_write);
    pty_output_write = NULL;
  }

  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_bytes);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = HeapAlloc(GetProcessHeap(), 0, attribute_bytes);
  if (attributes == NULL || !InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_bytes)) {
    print_win32_error(L"InitializeProcThreadAttributeList");
    if (attributes != NULL) HeapFree(GetProcessHeap(), 0, attributes);
    free(command_line);
    if (pseudo_console != NULL) ClosePseudoConsole(pseudo_console);
    if (pty_input_write != NULL) CloseHandle(pty_input_write);
    if (pty_output_read != NULL) CloseHandle(pty_output_read);
    CloseHandle(job);
    CloseHandle(parent);
    return EXIT_SETUP;
  }

  const DWORD_PTR attribute = pty_mode ? PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE : PROC_THREAD_ATTRIBUTE_HANDLE_LIST;
  void *attribute_value = pty_mode ? (void *)pseudo_console : (void *)std_handles;
  const SIZE_T attribute_size = pty_mode ? sizeof(pseudo_console) : sizeof(std_handles);
  if (!UpdateProcThreadAttribute(attributes, 0, attribute, attribute_value, attribute_size, NULL, NULL)) {
    print_win32_error(L"UpdateProcThreadAttribute");
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    free(command_line);
    if (pseudo_console != NULL) ClosePseudoConsole(pseudo_console);
    if (pty_input_write != NULL) CloseHandle(pty_input_write);
    if (pty_output_read != NULL) CloseHandle(pty_output_read);
    CloseHandle(job);
    CloseHandle(parent);
    return EXIT_SETUP;
  }

  STARTUPINFOEXW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup);
  if (!pty_mode) {
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = std_handles[0];
    startup.StartupInfo.hStdOutput = std_handles[1];
    startup.StartupInfo.hStdError = std_handles[2];
  }
  startup.lpAttributeList = attributes;

  PROCESS_INFORMATION child;
  ZeroMemory(&child, sizeof(child));
  const DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
                      CREATE_NEW_PROCESS_GROUP | EXTENDED_STARTUPINFO_PRESENT;
  if (pty_mode) SetStdHandle(STD_INPUT_HANDLE, NULL);
  const BOOL created = CreateProcessW(
    argv[command_index],
    command_line,
    NULL,
    NULL,
    pty_mode ? FALSE : TRUE,
    flags,
    NULL,
    NULL,
    &startup.StartupInfo,
    &child);
  if (pty_mode) SetStdHandle(STD_INPUT_HANDLE, std_handles[0]);

  DeleteProcThreadAttributeList(attributes);
  HeapFree(GetProcessHeap(), 0, attributes);
  free(command_line);

  if (!created) {
    print_win32_error(L"CreateProcess");
    if (pseudo_console != NULL) ClosePseudoConsole(pseudo_console);
    if (pty_input_write != NULL) CloseHandle(pty_input_write);
    if (pty_output_read != NULL) CloseHandle(pty_output_read);
    CloseHandle(job);
    CloseHandle(parent);
    return EXIT_SETUP;
  }

  if (!AssignProcessToJobObject(job, child.hProcess)) {
    print_win32_error(L"AssignProcessToJobObject");
    TerminateProcess(child.hProcess, EXIT_SETUP);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    if (pseudo_console != NULL) ClosePseudoConsole(pseudo_console);
    if (pty_input_write != NULL) CloseHandle(pty_input_write);
    if (pty_output_read != NULL) CloseHandle(pty_output_read);
    CloseHandle(job);
    CloseHandle(parent);
    return EXIT_SETUP;
  }

  if (ResumeThread(child.hThread) == (DWORD)-1) {
    print_win32_error(L"ResumeThread");
    TerminateJobObject(job, EXIT_SETUP);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    if (pseudo_console != NULL) ClosePseudoConsole(pseudo_console);
    if (pty_input_write != NULL) CloseHandle(pty_input_write);
    if (pty_output_read != NULL) CloseHandle(pty_output_read);
    CloseHandle(job);
    CloseHandle(parent);
    return EXIT_SETUP;
  }
  CloseHandle(child.hThread);

  if (pty_mode) {
    input_context.source = std_handles[0];
    input_context.destination = pty_input_write;
    output_context.source = pty_output_read;
    output_context.destination = std_handles[1];
    input_pump = CreateThread(NULL, 0, pump_stdin_to_pty, &input_context, 0, NULL);
    output_pump = CreateThread(NULL, 0, pump_pipe, &output_context, 0, NULL);
    if (input_pump == NULL || output_pump == NULL) {
      print_win32_error(L"CreateThread(pty pump)");
      TerminateJobObject(job, EXIT_SETUP);
    }
    const char ready[] = "LBT1 READY\n";
    _write(CONTROL_FD, ready, (unsigned int)(sizeof(ready) - 1));
  }

  HANDLE monitor_stop = CreateEventW(NULL, TRUE, FALSE, NULL);
  HANDLE monitor_thread = NULL;
  listener_monitor_context monitor_context;
  ZeroMemory(&monitor_context, sizeof(monitor_context));
  if (monitor_stop != NULL) {
    monitor_context.job = job;
    monitor_context.stop_event = monitor_stop;
    monitor_thread = CreateThread(NULL, 0, monitor_listeners, &monitor_context, 0, NULL);
  }

  HANDLE wait_handles[2] = {parent, child.hProcess};
  const DWORD wait_result = WaitForMultipleObjects(2, wait_handles, FALSE, INFINITE);
  DWORD exit_code = EXIT_SETUP;
  if (wait_result == WAIT_OBJECT_0 + 1) {
    if (!GetExitCodeProcess(child.hProcess, &exit_code)) exit_code = EXIT_SETUP;
  } else if (wait_result == WAIT_OBJECT_0) {
    exit_code = EXIT_PARENT_GONE;
    TerminateJobObject(job, exit_code);
    WaitForSingleObject(child.hProcess, 5000);
  } else {
    print_win32_error(L"WaitForMultipleObjects");
    TerminateJobObject(job, EXIT_SETUP);
  }

  if (monitor_stop != NULL) SetEvent(monitor_stop);
  if (monitor_thread != NULL) {
    WaitForSingleObject(monitor_thread, 2000);
    CloseHandle(monitor_thread);
  }
  if (monitor_stop != NULL) CloseHandle(monitor_stop);

  if (pty_mode) {
    ClosePseudoConsole(pseudo_console);
    if (pty_input_write != NULL) CloseHandle(pty_input_write);
    if (pty_output_read != NULL) CloseHandle(pty_output_read);
    if (input_pump != NULL) CloseHandle(input_pump);
    if (output_pump != NULL) CloseHandle(output_pump);
  }

  CloseHandle(child.hProcess);
  CloseHandle(job);
  CloseHandle(parent);
  return (int)exit_code;
}
