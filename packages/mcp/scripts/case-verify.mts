/**
 * 临时验证脚本：跑多站点真实采集案例，检查 IR 结构与 markdown 投影。
 * 用法: ./node_modules/.bin/tsx /tmp/case-verify.mts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserPool, FetchEngine, ProfileRegistry, effectiveProfile, layoutToMarkdown, profilesDir } from '@manta-fetcher/core';

// dev 脚本：额外扫描仓库根模板 profiles/（与 bench-run 一致）
const repoTemplatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../profiles');
const registry = new ProfileRegistry([repoTemplatesDir, profilesDir]);
await registry.reload();
const pool = new BrowserPool(1);
const engine = new FetchEngine(pool);

function summarize(label, result) {
  const nodes = result.layout.nodes;
  const roles = {};
  for (const n of nodes) roles[n.role] = (roles[n.role] || 0) + 1;
  const bodyCount = nodes.filter((n) => n.body).length;
  const levels = {};
  for (const n of nodes) levels[n.level] = (levels[n.level] || 0) + 1;
  console.log(`\n===== ${label} =====`);
  console.log(`title: ${result.title}`);
  console.log(`节点 ${nodes.length} | body ${bodyCount} | roles ${JSON.stringify(roles)} | levels ${JSON.stringify(levels)}`);
  const top = nodes.filter((n) => n.level >= 4).slice(0, 4);
  for (const n of top) {
    const txt = (n.runs || []).map((r) => r.t).join('').slice(0, 40) || n.img || '';
    console.log(`  L${n.level} ${n.role}${n.body ? ' 核心' : ''} [${n.rect.join(',')}] ${txt}`);
  }
  const md = layoutToMarkdown(result.layout);
  console.log(`--- markdown 头 220 字 ---`);
  console.log(md.slice(0, 220).replace(/\n+/g, ' ⏎ '));
  return nodes;
}

// 案例 1：掘金文章（article 模式基线）
{
  const r = await engine.fetch('https://juejin.cn/post/7637856870833635343', effectiveProfile(registry.byName('juejin')?.def ?? null));
  summarize('juejin 文章', r);
}

// 案例 2：AIbase 资讯列表页（无 pageType 声明，观察 article 缺省下的列表页表现）
{
  const r = await engine.fetch('https://news.aibase.com/zh/news', effectiveProfile(registry.byName('aibase-news')?.def ?? null));
  const nodes = summarize('aibase 列表页', r);
  // 抽取第一条详情链接
  const hrefs = [];
  for (const n of nodes) for (const run of n.runs || []) if (run.href && /\/zh\/news\/\d+/.test(run.href)) hrefs.push(run.href);
  const detail = hrefs.find((h) => h.startsWith('http')) ?? (hrefs[0] ? new URL(hrefs[0], 'https://news.aibase.com').href : null);
  console.log(`详情链接样本: ${detail}`);
  if (detail) {
    const d = await engine.fetch(detail, effectiveProfile(registry.byName('aibase-article')?.def ?? null));
    summarize('aibase 详情页', d);
  }
}

// 案例 3：搜狗微信搜索（中转链）→ 微信文章正文
{
  const eff = effectiveProfile(registry.byName('sogou-weixin')?.def ?? null);
  const r = await engine.fetch('https://weixin.sogou.com/weixin?type=2&query=ai', eff);
  const nodes = summarize('sogou 微信搜索列表', r);
  const link = nodes.flatMap((n) => (n.runs || []).map((x) => x.href)).find((h) => h && h.includes('/link'));
  console.log(`中转链: ${link ? link.slice(0, 80) : '(无)'}`);
  if (link) {
    const finalUrl = await engine.resolveRedirect('sogou-weixin', new URL(link, 'https://weixin.sogou.com').href, 20000, eff.cdpEndpoint);
    console.log(`最终落点: ${finalUrl}`);
    if (/mp\.weixin\.qq\.com/.test(finalUrl)) {
      const w = await engine.fetch(finalUrl, effectiveProfile(registry.byName('weixin-article')?.def ?? null));
      summarize('微信文章', w);
    } else {
      console.log('未落到 mp.weixin.qq.com，跳过正文抓取');
    }
  }
}

await pool.close();
