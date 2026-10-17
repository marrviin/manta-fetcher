import { BrowserPool, FetchEngine, effectiveProfile, loginAndWait, type SiteProfile } from '../src/index.js';

// 1. 嵌套结构化字段
const html = `<html><body><ul>
  <li class="item"><span class="rank">1</span><a class="title" href="/post/a">文章A</a><span class="heat">134k</span></li>
  <li class="item"><span class="rank">2</span><a class="title" href="/post/b">文章B</a><span class="heat">38k</span></li>
  <li class="item"><span class="rank">3</span><a class="title" href="/post/c">文章C</a><span class="heat">5k</span></li>
  <li class="item"><span class="rank">4</span><a class="title" href="/post/d">文章D</a><span class="heat">1k</span></li>
</ul></body></html>`;
const profile: SiteProfile = {
  name: 'test-list',
  match: [],
  structured: {
    fields: {
      top3: {
        selector: 'li.item',
        multiple: true,
        limit: 3,
        fields: {
          rank: { selector: '.rank' },
          title: { selector: 'a.title' },
          url: { selector: 'a.title', attribute: 'href' },
          heat: { selector: '.heat' },
        },
      },
    },
  },
};
const pool = new BrowserPool(1);
const engine = new FetchEngine(pool);
const r = await engine.fetch('data:text/html;charset=utf-8,' + encodeURIComponent(html), effectiveProfile(profile), { structured: true });
console.log('nested fields:', JSON.stringify(r.structured));

// 2. loginAndWait 无 stdin 依赖（5s 超时路径）
const t0 = Date.now();
const login = await loginAndWait('test-site', { loginUrl: 'https://example.com', timeoutMs: 5000 });
console.log('loginAndWait:', JSON.stringify(login), `耗时 ${Math.round((Date.now() - t0) / 1000)}s`);

await pool.close();
