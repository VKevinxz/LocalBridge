import type { Client } from '@modelcontextprotocol/client';

/** Llama una tool y decodifica su `content[0].text` como JSON, sea éxito o error. */
export async function callToolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; parsed: Record<string, unknown>; raw: unknown }> {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : undefined;

  return {
    isError: result.isError === true,
    parsed: text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>),
    raw: result,
  };
}
