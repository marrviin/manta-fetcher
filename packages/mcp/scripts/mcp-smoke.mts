import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('packages/mcp/dist/index.js')],
  cwd: process.cwd(),
  env: { ...process.env } as Record<string, string>, // 透传 MANTA_FETCHER_PROFILES_DIR 等给 server 子进程
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

// 1. 需登录场景：无登录态应快速失败并给出 login 指引
const res = await client.callTool({ name: 'fetch_juejin_hot', arguments: { url: 'https://juejin.cn/hot/articles' } });
const text = (res.content as any)?.[0]?.text ?? '';
console.log('--- fetch_juejin_hot（未登录） ---');
console.log('isError:', res.isError, '|', text.slice(0, 200));

// 2. 文章场景回归
const res2 = await client.callTool({ name: 'fetch_juejin', arguments: { url: 'https://juejin.cn/post/7637856870833635343' } });
const text2 = (res2.content as any)?.[0]?.text ?? '';
console.log('--- fetch_juejin 回归 ---');
console.log('isError:', res2.isError, '|', text2.slice(0, 100));

await client.close();
process.exit(0);
