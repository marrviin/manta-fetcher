import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
setTimeout(() => { console.error('120s 超时退出'); process.exit(2); }, 120_000).unref();
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('packages/mcp/dist/index.js')], cwd: process.cwd() });
const client = new Client({ name: 'ctrip-test', version: '0.0.0' });
await client.connect(transport);
const res = await client.callTool({
  name: 'fetch_ctrip_flight',
  arguments: {
    url: 'https://flights.ctrip.com/online/list/oneway-sha-weh?depdate=2026-10-20&cabin=y_s_c_f&adult=1&child=0&infant=0',
    structured: true,
    saveTo: 'cache/articles',
  },
});
console.log('isError:', res.isError);
const sc = res as { structuredContent?: { fields?: { flights?: unknown[] }; saved?: { file: string }[] } };
console.log('航班结构化数据:', JSON.stringify(sc.structuredContent?.fields?.flights, null, 2)?.slice(0, 900));
const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
console.log('--- md 摘录 ---');
console.log(text.slice(0, 400));
if (sc.structuredContent?.saved) console.log('saved:', sc.structuredContent.saved.map((s) => s.file));
await client.close();
process.exit(0);
