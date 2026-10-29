/**
 * bench 离线重算入口（不出网，只读缓存工件）：
 *   tsx packages/bench/scripts/bench-report.mts [--case <name>]
 * 从 ~/.manta-fetcher/cache/bench/<case>/ 的 engines/*.md + dom-stats.json +
 * pageText.txt + gold.json 重算全部指标，输出与 bench-run 相同格式的报告。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BENCH_CASES } from '../src/cases.mts';
import { BENCH_DIR } from '../src/capture.mts';
import { aggregate, aggregateBySuite, buildCaseReport, formatReport } from '../src/report.mts';
import { writeHtmlReport } from '../src/html.mts';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const onlyCase = arg('--case');
const selected = BENCH_CASES.filter((c) => !onlyCase || c.name === onlyCase);

const reports = [];
for (const c of selected) {
  const rep = buildCaseReport(c.name, c.url, c.profileName);
  if (rep) reports.push(rep);
  else console.error(`✗ ${c.name}: 缓存不完整（缺 snapshot/pageText/dom-stats），先跑 bench-run.mts`);
}
if (!reports.length) {
  console.error('无可报告用例');
  process.exit(1);
}
console.log(formatReport(reports));
console.log('\n========== 聚合 ==========');
console.log(JSON.stringify(aggregate(reports), null, 2));
console.log('\n========== 分套件聚合（profiled / generic）==========');
console.log(JSON.stringify(aggregateBySuite(reports), null, 2));
fs.writeFileSync(
  path.join(BENCH_DIR, 'bench-report.json'),
  JSON.stringify(
    { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: reports, aggregate: aggregate(reports), aggregateBySuite: aggregateBySuite(reports) },
    null, 2,
  ),
);
console.log(`\n报告已写入 ${path.join(BENCH_DIR, 'bench-report.json')}`);
const htmlPath = writeHtmlReport(BENCH_DIR, reports, { append: false });
console.log(`HTML 报告（含历史趋势）: ${htmlPath}`);
