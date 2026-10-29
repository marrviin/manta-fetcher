/**
 * 掘金热榜前 3 落盘采集（薄封装）：直接用 fetch_juejin_hot_top3 + saveTo。
 * 落盘布局与引擎统一：cache/articles/<站点>/<YYYY-MM-DD>/<HHmmss>-<NN-标题>.md
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';

const HOT_URL = 'https://juejin.cn/hot/articles';
const SAVE_DIR = process.argv[2] ?? 'cache/articles';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('packages/mcp/dist/index.js')],
  cwd: process.cwd(),
});
const client = new Client({ name: 'juejin-hot-demo', version: '0.0.0' });
await client.connect(transport);

const textOf = (r: { content?: { type: string; text?: string }[] }): string =>
  r.content?.find((c) => c.type === 'text')?.text ?? '';

let res = await client.callTool({
  name: 'fetch_juejin_hot_top3',
  arguments: { url: HOT_URL, saveTo: SAVE_DIR },
});
// 无登录态 → 主动走登录流程后重试
if (res.isError && textOf(res as never).includes('login_')) {
  console.error('[demo] 热榜需要登录，主动调用 login_juejin_hot（请在弹出的浏览器窗口完成登录）...');
  const login = await client.callTool({ name: 'login_juejin_hot', arguments: {} });
  if (login.isError) throw new Error(textOf(login as never));
  console.error('[demo] 登录成功，重试');
  res = await client.callTool({
    name: 'fetch_juejin_hot_top3',
    arguments: { url: HOT_URL, saveTo: SAVE_DIR },
  });
}
if (res.isError) throw new Error(textOf(res as never));

const sc = res as { structuredContent?: { saved?: { file: string; title: string }[] } };
console.error('[demo] 已保存:');
for (const s of sc.structuredContent?.saved ?? []) console.error(`  ${s.title} → ${s.file}`);
await client.close();
process.exit(0);
