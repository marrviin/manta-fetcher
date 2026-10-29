/**
 * IR 金样回归：对确定性 fixture（scripts/fixtures/*.html）跑完整采集管线，
 * 与入库金样（fixtures/golden/*.json）做精确 diff。
 * 用途：重构（常量收敛/参数化/泄漏清理）必须保持金样零 diff——行为逐字节不变。
 *   pnpm exec tsx scripts/ir-golden.mts           # 对照
 *   pnpm exec tsx scripts/ir-golden.mts --update  # 重录金样（有意的行为变更后）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserPool, FetchEngine, effectiveProfile, type PageLayout } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures');
const goldenDir = path.join(fixtureDir, 'golden');
const update = process.argv.includes('--update');

/** 金样剔除非确定字段：url（data URL 编码细节）、viewport（依赖运行环境窗口） */
function normalize(layout: PageLayout): Record<string, unknown> {
  return {
    docHeight: layout.docHeight,
    truncated: layout.truncated ?? false,
    nodes: layout.nodes,
  };
}

const cases = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.html')).sort();
if (!cases.length) {
  console.error(`无 fixture: ${fixtureDir}`);
  process.exit(1);
}
/** 个别 fixture 需要非缺省 profile.layout（feed 页跳过核心区间） */
const PAGE_TYPE_OVERRIDES: Record<string, 'article' | 'feed' | 'list'> = {
  'feed.html': 'feed',
  'feed-links.html': 'feed',
};

const pool = new BrowserPool(1);
const engine = new FetchEngine(pool);
let failed = 0;
try {
  for (const f of cases) {
    const html = fs.readFileSync(path.join(fixtureDir, f), 'utf8');
    const pageType = PAGE_TYPE_OVERRIDES[f];
    const result = await engine.fetch(
      'data:text/html;charset=utf-8,' + encodeURIComponent(html),
      effectiveProfile(pageType ? { name: 'generic', layout: { pageType } } : null),
    );
    const actual = JSON.stringify(normalize(result.layout), null, 2);
    const golden = path.join(goldenDir, f.replace(/\.html$/, '.json'));
    if (update || !fs.existsSync(golden)) {
      fs.mkdirSync(goldenDir, { recursive: true });
      fs.writeFileSync(golden, actual);
      console.log(`${fs.existsSync(golden) && !update ? '' : '重录'}金样: ${path.relative(here, golden)}（节点 ${result.layout.nodes.length}）`);
    } else if (fs.readFileSync(golden, 'utf8') === actual) {
      console.log(`✓ ${f}（节点 ${result.layout.nodes.length}）`);
    } else {
      failed++;
      console.error(`✗ ${f} 与金样不一致 —— 若为有意变更，用 --update 重录；否则排查回归`);
    }
  }
} finally {
  await pool.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
