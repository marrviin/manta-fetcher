import { BrowserPool, FetchEngine, effectiveProfile, loginAndWait } from '../src/index.js';

// 1. data-URL 采集：IR 管线冒烟（语义 role + body 标记）
const html = `<html><body><article>
  <h1>冒烟标题</h1>
  <p>第一段正文，长度超过十字，用于触发正文聚类与核心内容区间标记。</p>
  <p>第二段正文，同样式，构成正文聚类的主体文本量。</p>
</article></body></html>`;
const pool = new BrowserPool(1);
const engine = new FetchEngine(pool);
const r = await engine.fetch(
  'data:text/html;charset=utf-8,' + encodeURIComponent(html),
  effectiveProfile(null),
);
const roles = r.layout.nodes.map((n) => n.role).join(',');
const bodyCount = r.layout.nodes.filter((n) => n.body).length;
console.log(`IR: 节点 ${r.layout.nodes.length}（${roles}）| body ${bodyCount} | title=${r.title}`);
if (!r.layout.nodes.length || bodyCount < 2) {
  console.error('IR 冒烟失败：节点或 body 标记异常');
  process.exit(1);
}

// 2. loginAndWait 无 stdin 依赖（5s 超时路径）
const t0 = Date.now();
const login = await loginAndWait('test-site', { loginUrl: 'https://example.com', timeoutMs: 5000 });
console.log('loginAndWait:', JSON.stringify(login), `耗时 ${Math.round((Date.now() - t0) / 1000)}s`);

await pool.close();
