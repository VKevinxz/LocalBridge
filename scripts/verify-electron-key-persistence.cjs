const { app, safeStorage } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const phase = process.argv[2];
const root = process.env.LOCALBRIDGE_KEY_PERSISTENCE_TEST_ROOT;
if ((phase !== 'write' && phase !== 'read') || typeof root !== 'string' || root.length === 0) {
  throw new Error('Expected write/read phase and an isolated test root.');
}

app.setPath('userData', path.join(root, 'electron-profile'));

app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable.');
  const keyPath = path.join(root, 'credential.enc');
  const fixture = 'localbridge-runtime-key-persistence-fixture';
  if (phase === 'write') {
    const encrypted = safeStorage.encryptString(fixture);
    if (encrypted.includes(Buffer.from(fixture, 'utf8'))) throw new Error('Encrypted blob contains plaintext.');
    await writeFile(keyPath, encrypted);
    process.stdout.write('Electron key persistence phase write passed.\n');
  } else {
    const encrypted = await readFile(keyPath);
    if (safeStorage.decryptString(encrypted) !== fixture) throw new Error('Credential did not survive an Electron restart.');
    process.stdout.write('Electron key persistence phase read passed.\n');
  }
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
