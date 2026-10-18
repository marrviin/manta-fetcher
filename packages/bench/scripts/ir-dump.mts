/** 调试：线上采集单 case（与 bench-run 相同路径）并把完整 IR layout 落盘 <case>/layout.json */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (process.cwd() !== repoRoot) process.chdir(repoRoot);
const { BrowserPool, ProfileRegistry } = await import('@manta-fetcher/core');
const { BENCH_CASES } = await import('../src/cases.mts');
const { captureCase, caseDir } = await import('../src/capture.mts');

const name = process.argv[2];
const c = BENCH_CASES.find((x) => x.name === name);
if (!c) { console.error(`未找到 case: ${name}`); process.exit(1); }
const registry = new ProfileRegistry();
await registry.reload();
const pool = new BrowserPool(1);
const res = await captureCase(c, registry, pool);
fs.writeFileSync(path.join(caseDir(name), 'layout.json'), JSON.stringify(res.manta.layout, null, 1));
console.log(`layout.json 已写入（节点 ${res.manta.layout.nodes.length}）`);
await pool.close();
