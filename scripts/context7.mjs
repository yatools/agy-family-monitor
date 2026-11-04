// Transient MCP client; does not change the user's Codex configuration.
const [name, args] = process.argv.slice(2);
if (!['resolve-library-id', 'query-docs'].includes(name) || !args) {
  throw new Error('Usage: node scripts/context7.mjs <tool-name> <JSON-arguments>');
}
const response = await fetch('https://mcp.context7.com/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: JSON.parse(args) },
  }),
  signal: AbortSignal.timeout(60000),
});
if (!response.ok) throw new Error(`Context7 MCP HTTP ${response.status}`);
const raw = await response.text();
const data = raw
  .split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => JSON.parse(line.slice(6)));
for (const packet of data.length ? data : [JSON.parse(raw)]) {
  if (packet.error || packet.result?.isError) throw new Error(JSON.stringify(packet));
  for (const item of packet.result?.content ?? []) if (item.type === 'text') console.log(item.text);
}
