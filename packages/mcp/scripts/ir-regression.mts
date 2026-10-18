/**
 * IR 线上快照回归（容差对照）：
 *   pnpm exec tsx packages/mcp/scripts/ir-regression.mts capture      # 采集基线快照
 *   pnpm exec tsx packages/mcp/scripts/ir-regression.mts              # 重采并对照
 *   pnpm exec tsx packages/mcp/scripts/ir-regression.mts -- --tolerance 0.02
 * 快照存用户级目录（~/.manta-fetcher/cache/ir-snapshots）。线上页面会漂移，
 * 同一天内 capture→diff 应零差异；跨天对照看 role/body/level 偏移计数与 importance 漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserPool, effectiveProfile, FetchEngine, ProfileRegistry } from '@manta-fetcher/core';

const SNAPSHOT_DIR = path.join(os.homedir(), '.manta-fetcher', 'cache', 'ir-snapshots');
const capture = process.argv.includes('capture');
const tolIdx = process.argv.indexOf('--tolerance');
const tolerance = tolIdx >= 0 ? Number(process.argv[tolIdx + 1]) || 0 : 0;

const CASES: { name: string; url: string }[] = [
  { name: 'juejin-post', url: 'https://juejin.cn/post/7637856870833635343' },
  { name: 'juejin-post-code', url: 'https://juejin.cn/post/7488201614714863631' },
];

const registry = new ProfileRegistry();
await registry.reload();
const pool = new BrowserPool(1);
const engine = new FetchEngine(pool);
let failed = 0;

try {
  for (const c of CASES) {
    const profile = registry.match(c.url);
    const result = await engine.fetch(c.url, effectiveProfile(profile?.def ?? null));
    const snap = {
      title: result.title,
      nodeCount: result.layout.nodes.length,
      docHeight: result.layout.docHeight,
      // 只对照稳定语义字段；rect 依赖线上渲染，跨天漂移属预期
      nodes: result.layout.nodes.map((n) => ({
        role: n.role,
        body: n.body ?? false,
        level: n.level,
        importance: n.importance,
      })),
    };
    const file = path.join(SNAPSHOT_DIR, `${c.name}.json`);
    if (capture || !fs.existsSync(file)) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(snap, null, 2));
      console.log(`快照建立: ${path.basename(file)}（${snap.nodeCount} 节点）`);
      continue;
    }
    const base = JSON.parse(fs.readFileSync(file, 'utf8'));
    const diffs: string[] = [];
    if (base.nodeCount !== snap.nodeCount)
      diffs.push(`节点数 ${base.nodeCount} → ${snap.nodeCount}`);
    const n = Math.max(base.nodes.length, snap.nodes.length);
    let impDrift = 0;
    for (let i = 0; i < n; i++) {
      const a = base.nodes[i];
      const b = snap.nodes[i];
      if (!a || !b) {
        diffs.push(`#${i} 单侧缺失`);
        continue;
      }
      if (a.role !== b.role) diffs.push(`#${i} role ${a.role}→${b.role}`);
      if (a.body !== b.body) diffs.push(`#${i} body ${a.body}→${b.body}`);
      if (a.level !== b.level) diffs.push(`#${i} level ${a.level}→${b.level}`);
      if (Math.abs(a.importance - b.importance) > tolerance) impDrift++;
    }
    if (impDrift) diffs.push(`importance 漂移（> ${tolerance}）: ${impDrift} 个节点`);
    if (diffs.length) {
      failed++;
      console.error(`✗ ${c.name}: ${diffs.length} 处差异`);
      for (const d of diffs.slice(0, 10)) console.error(`   ${d}`);
    } else {
      console.log(`✓ ${c.name}（${snap.nodeCount} 节点，零差异）`);
    }
  }
} finally {
  await pool.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
