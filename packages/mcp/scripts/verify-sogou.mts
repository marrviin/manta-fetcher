import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('packages/mcp/dist/index.js')], cwd: process.cwd() });
const client = new Client({ name: 'verify-sogou', version: '0.0.0' });
await client.connect(transport);
const res = await client.callTool({
  name: 'fetch_sogou_weixin_top3',
  arguments: { url: 'https://weixin.sogou.com/weixin?type=2&query=ai', saveTo: 'cache/articles' },
});
console.log('isError:', res.isError);
const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
const savedIdx = text.indexOf('已保存');
console.log(savedIdx >= 0 ? text.slice(savedIdx) : '(无保存信息)');
const sc = res as { structuredContent?: { saved?: { title: string; file: string }[] } };
console.log('structuredContent.saved:', JSON.stringify(sc.structuredContent?.saved, null, 2));
await client.close();
process.exit(0);
