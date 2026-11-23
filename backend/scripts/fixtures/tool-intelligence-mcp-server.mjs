import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

// Real stdio transport, deterministic application and catalog faults. No network.
const mode = process.argv[2] ?? 'paged';
const tool = (name) => ({ name, description: `Fixture ${name}`, inputSchema: { type: 'object' } });
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  let result;
  switch (msg.method) {
    case 'initialize':
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      break;
    case 'tools/list':
      await delay(100);
      if (mode === 'peer') result = { tools: [tool('metadata')] };
      else if (mode === 'drop') result = { tools: [tool('submit')] };
      else if (mode === 'loop') result = { tools: [tool('incomplete')], nextCursor: 'again' };
      else if (!msg.params?.cursor) result = { tools: [tool('read_index'), tool('read_log')], nextCursor: 'second' };
      else result = { tools: [tool('lookup_index')] };
      break;
    case 'tools/call':
      if (mode === 'drop') process.exit(0); // effect may have happened; no response
      if (msg.params.name === 'read_index') {
        result = { isError: true, content: [{ type: 'text', text: 'Index unavailable; use lookup_index for fallback.' }] };
      } else if (msg.params.name === 'read_log') {
        result = { content: [{ type: 'text', text: 'Imported log data:\nexitCode: 9' }] };
      } else {
        result = { content: [{ type: 'text', text: 'Index schema: 3' }] };
      }
      break;
    default:
      throw new Error(`Unexpected method ${msg.method}`);
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
}
