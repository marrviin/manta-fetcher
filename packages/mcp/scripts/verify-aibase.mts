import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('packages/mcp/dist/index.js')], cwd: process.cwd() });
const client = new Client({ name: 'verify-aibase', version: '0.0.0' });
await client.connect(transport);
const res = await client.callTool({
  name: 'fetch_aibase_news_top3',
  arguments: { url: 'https://news.aibase.com/zh/news', saveTo: 'cache/articles' },
});
console.log('isError:', res.isError);
const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
console.log(text.slice(0, 600));
console.log('...(总长', text.length, '字符)');
const sc = res as { structuredContent?: { saved?: { file: string }[] } };
if (sc.structuredContent?.saved) console.log('saved:', sc.structuredContent.saved.map((s) => s.file));
await client.close();
process.exit(0);
