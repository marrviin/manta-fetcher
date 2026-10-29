// composite 冒烟：临时工作目录 + 本地 HTTP 详情页，验证"纯配置驱动"的列表→详情编排
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-composite-'));
fs.mkdirSync(path.join(work, 'profiles'));
fs.writeFileSync(path.join(work, 'profiles', 'list.yaml'), `
name: demo-list
match: []
navigation:
  waitUntil: "visible:li.item"
structured:
  fields:
    items:
      selector: "li.item"
      multiple: true
      fields:
        title: { selector: "a.t" }
        url:   { selector: "a.t", attribute: "href" }
composite:
  detailProfile: demo-detail
  urlField: url
  detailLimit: 2
  tool: demo_list_items
`);
fs.writeFileSync(path.join(work, 'profiles', 'detail.yaml'), `
name: demo-detail
match: ["http://127.0.0.1:0/*"]
extraction:
  mainContent: "article"
`);

const listHtml = '<ul><li class="item"><a class="t" href="/d1">甲</a></li><li class="item"><a class="t" href="/d2">乙</a></li><li class="item"><a class="t" href="/d3">丙</a></li></ul>';
const pages: Record<string, string> = {
  '/list': `<html><body>${listHtml}</body></html>`,
  '/d1': '<html><body><article><h2>详情一</h2><p>内容一</p></article></body></html>',
  '/d2': '<html><body><article><h2>详情二</h2><p>内容二</p></article></body></html>',
  '/d3': '<html><body><article><h2>详情三</h2><p>内容三</p></article></body></html>',
};
const server = http.createServer((req, res) => {
  const body = pages[req.url ?? '/'] ?? '<html><body>not found</body></html>';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
// detail match 通配端口
fs.writeFileSync(path.join(work, 'profiles', 'detail.yaml'), `
name: demo-detail
match: ["http://127.0.0.1:${port}/*"]
extraction:
  mainContent: "article"
`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('packages/mcp/dist/index.js')],
  cwd: work,
});
const client = new Client({ name: 'composite-smoke', version: '0.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const res = await client.callTool({ name: 'demo_list_items', arguments: { url: `http://127.0.0.1:${port}/list` } });
const sc = res as { structuredContent?: { items?: { title?: string; detailTitle?: string; detailUrl?: string; error?: string }[] } };
console.log('isError:', res.isError);
console.log('items:', JSON.stringify(sc.structuredContent?.items, null, 2));
const text = (res.content as { type: string; text?: string }[])?.find((c) => c.type === 'text')?.text ?? '';
console.log('--- markdown 头 300 字 ---');
console.log(text.slice(0, 300));

await client.close();
server.close();
fs.rmSync(work, { recursive: true, force: true });
process.exit(0);
