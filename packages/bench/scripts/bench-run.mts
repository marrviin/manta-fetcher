/**
 * 抽取效果双向对比基准（在线入口）：
 *   tsx packages/bench/scripts/bench-run.mts [--case <name>] [--engine manta,raw-turndown,readability-turndown] [--url <override>] [--no-report]
 * 流程：每 case 一个页面（与 FetchEngine 相同生命周期 + warmPageForLayout 暖场）→
 * dump 统一快照（懒加载回填）→ manta 同页采集 → 基线引擎离线解析同一快照 →
 * 指标计算 → 控制台报告 + bench-report.json。
 * 工件：~/.manta-fetcher/cache/bench/<case>/；金样另跑 bench-gold.mts。
 * 注意：profile 目录按 cwd 解析，本入口启动时自动切到仓库根再加载依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchCase } from '../src/cases.mts';
import type { CaptureResult } from '../src/capture.mts';
import type { CaseReport } from '../src/report.mts';

// profiles/ 按 cwd 解析（packages/core/src/paths.ts）：不在仓库根则先切过去，再动态加载触及 paths.ts 的模块
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (!fs.existsSync(path.join(repoRoot, 'profiles'))) {
  console.error(`未找到 ${path.join(repoRoot, 'profiles')}，请在 manta-fetcher 仓库内运行`);
  process.exit(1);
}
if (process.cwd() !== repoRoot) process.chdir(repoRoot);

const { BrowserPool, FetchEngine, ProfileRegistry, effectiveProfile, profilesDir } = await import('@manta-fetcher/core');
const { BENCH_CASES } = await import('../src/cases.mts');
const { captureBaselineE2E, captureCase, BENCH_DIR, caseDir } = await import('../src/capture.mts');
const { OFFLINE_ENGINES } = await import('../src/engines.mts');
const { aggregate, aggregateBySuite, buildCaseReport, formatReport } = await import('../src/report.mts');
const { writeHtmlReport } = await import('../src/html.mts');

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const onlyCase = arg('--case');
const urlOverride = arg('--url');
const engineArg = arg('--engine');
const noReport = process.argv.includes('--no-report');
const noE2E = process.argv.includes('--no-e2e');
const selectedEngines = engineArg ? engineArg.split(',').map((s) => s.trim()) : null;

const cases: BenchCase[] = BENCH_CASES.filter((c) => !onlyCase || c.name === onlyCase).map((c) =>
  urlOverride && onlyCase === c.name ? { ...c, url: urlOverride } : c,
);
if (!cases.length) {
  console.error(`未找到 case: ${onlyCase ?? ''}（可选: ${BENCH_CASES.map((c) => c.name).join(', ')}）`);
  process.exit(1);
}

// dev 脚本：额外扫描仓库根模板 profiles/（bench case 的 profile 即模板）
const registry = new ProfileRegistry([path.join(repoRoot, "profiles"), profilesDir]);
await registry.reload();
const pool = new BrowserPool(1);
const engine = new FetchEngine(pool);
const caseReports: CaseReport[] = [];
const skipped: { case: string; reason: string }[] = [];

/** redirect 型用例：列表页 IR 抽中转链 → 同会话解析最终 URL */
async function resolveRedirectCase(c: BenchCase): Promise<string | null> {
  const srcEff = effectiveProfile(registry.byName(c.linkSourceProfile!)?.def ?? null);
  const list = await engine.fetch(c.url, srcEff);
  const link = list.layout.nodes
    .flatMap((n) => (n.runs || []).map((x) => x.href))
    .find((h) => h && h.includes(c.linkPattern ?? '/link'));
  if (!link) return null;
  const finalUrl = await engine.resolveRedirect(
    c.linkSourceProfile!,
    new URL(link, c.url).href,
    20000,
    srcEff.cdpEndpoint,
  );
  if (c.finalUrlPattern && !new RegExp(c.finalUrlPattern).test(finalUrl)) return null;
  return finalUrl;
}

/** 单 case 共享尾段：跑离线引擎 + 出 case 报告（manta 采集已完成或已落 meta） */
function runOfflineAndReport(c: BenchCase, url: string): void {
  const dir = caseDir(c.name);
  const snapshotPath = path.join(dir, 'snapshot.html');
  if (fs.existsSync(snapshotPath)) {
    const snapshotHtml = fs.readFileSync(snapshotPath, 'utf8');
    for (const [name, fn] of Object.entries(OFFLINE_ENGINES)) {
      if (selectedEngines && !selectedEngines.includes(name)) continue;
      const out = fn(snapshotHtml, url);
      fs.writeFileSync(path.join(dir, 'engines', `${name}.md`), out.md);
      fs.writeFileSync(path.join(dir, 'engines', `${name}.meta.json`), JSON.stringify(out.meta, null, 2));
      console.log(`${name}: ${out.meta.success ? `md ${out.md.length} 字符` : `失败 ${out.meta.error}`}（${out.meta.ms.total}ms）`);
    }
  } else {
    console.error('无快照（manta 采集失败），离线引擎跳过');
  }
}

/** case 报告构建（须在离线引擎与端到端采集都落盘后调用） */
function reportCase(c: BenchCase, url: string): void {
  const rep = buildCaseReport(c.name, url, c.profileName);
  if (rep) caseReports.push(rep);
}

/**
 * Jina Reader 在线基线（r.jina.ai 代理抓取，自有渲染管线）：与离线引擎不同，
 * 它看到的页面是自己的抓取结果，指标相对该输出 + 金样。无 JINA_API_KEY 走免费档
 * （~20 rpm），用例间强制间隔；失败记 success:false，不中断基准。
 */
const JINA_FREE_DELAY_MS = 3200;
async function runJina(c: BenchCase, url: string): Promise<void> {
  if (selectedEngines && !selectedEngines.includes('jina-reader')) return;
  const dir = caseDir(c.name);
  const t0 = Date.now();
  const writeFail = (error: string): void => {
    fs.writeFileSync(
      path.join(dir, 'engines', 'jina-reader.meta.json'),
      JSON.stringify({ success: false, error, ms: { total: Date.now() - t0 }, profileAware: false }, null, 2),
    );
    console.error(`jina-reader: 失败 ${error}（${Date.now() - t0}ms）`);
  };
  try {
    const headers: Record<string, string> = { accept: 'text/plain' };
    if (process.env.JINA_API_KEY) headers.authorization = `Bearer ${process.env.JINA_API_KEY}`;
    else await new Promise((r) => setTimeout(r, JINA_FREE_DELAY_MS));
    const resp = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(120_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const md = await resp.text();
    if (!md.trim()) throw new Error('空输出');
    fs.writeFileSync(path.join(dir, 'engines', 'jina-reader.md'), md);
    fs.writeFileSync(
      path.join(dir, 'engines', 'jina-reader.meta.json'),
      JSON.stringify({ success: true, ms: { total: Date.now() - t0 }, profileAware: false }, null, 2),
    );
    console.log(`jina-reader: md ${md.length} 字符（${Date.now() - t0}ms）`);
  } catch (err) {
    writeFail(err instanceof Error ? err.message : String(err));
  }
}

/** manta 采集（含失败落盘 meta），返回采集结果或 null */
async function runManta(c: BenchCase, url: string): Promise<CaptureResult | null> {
  const dir = caseDir(c.name);
  try {
    const cap = await captureCase({ ...c, url }, registry, pool);
    fs.writeFileSync(path.join(dir, 'engines', 'manta.md'), cap.manta.md);
    fs.writeFileSync(path.join(dir, 'engines', 'manta.meta.json'), JSON.stringify(cap.manta.meta, null, 2));
    fs.writeFileSync(path.join(dir, 'engines', 'manta.ir.json'), JSON.stringify(cap.manta.layout, null, 1));
    console.log(
      `manta: 节点 ${cap.manta.layout.nodes.length} md ${cap.manta.md.length} 字符（warm ${cap.manta.meta.ms.warm}ms collect ${cap.manta.meta.ms.collect}ms）`,
    );
    return cap;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`manta 采集失败: ${msg}`);
    fs.writeFileSync(
      path.join(dir, 'engines', 'manta.meta.json'),
      JSON.stringify({ success: false, error: msg, ms: {}, profileAware: !!c.profileName }, null, 2),
    );
    return null;
  }
}

try {
  for (const c of cases) {
    const dir = caseDir(c.name);
    fs.mkdirSync(path.join(dir, 'engines'), { recursive: true });
    console.log(`\n== ${c.name} ==`);
    let url = c.url;

    if (c.kind === 'redirect') {
      try {
        const finalUrl = await resolveRedirectCase(c);
        if (!finalUrl) {
          console.error('中转链解析失败/落点不符，case 跳过');
          skipped.push({ case: c.name, reason: 'redirect 解析失败或落点不符' });
          continue;
        }
        url = finalUrl;
        console.log(`中转落点: ${url.slice(0, 90)}`);
      } catch (err) {
        console.error(`中转解析异常: ${err instanceof Error ? err.message : err}`);
        skipped.push({ case: c.name, reason: String(err instanceof Error ? err.message : err) });
        continue;
      }
    }

    const cap = await runManta(c, url);
    if (cap && c.kind === 'direct') url = cap.manta.url || url;
    runOfflineAndReport(c, url);

    // 端到端层：基线各自真实流程（自行导航、无预热、无懒加载回填），质量相对各自看到的页面
    if (!noE2E) {
      for (const [name, fn] of Object.entries(OFFLINE_ENGINES)) {
        if (selectedEngines && !selectedEngines.includes(name)) continue;
        try {
          const e2e = await captureBaselineE2E(url, pool);
          fs.writeFileSync(path.join(dir, 'e2e-snapshot.html'), e2e.html);
          fs.writeFileSync(path.join(dir, 'e2e-pageText.txt'), e2e.text);
          fs.writeFileSync(path.join(dir, 'e2e-dom-stats.json'), JSON.stringify(e2e.stats, null, 2));
          const parseT0 = Date.now();
          const out = fn(e2e.html, url);
          const parseMs = Date.now() - parseT0;
          fs.writeFileSync(path.join(dir, 'engines', `${name}.e2e.md`), out.md);
          fs.writeFileSync(
            path.join(dir, 'engines', `${name}.e2e.meta.json`),
            JSON.stringify(
              { success: out.meta.success, error: out.meta.error, ms: { total: e2e.ms.total + parseMs, wait: e2e.ms.total, parse: parseMs }, profileAware: false },
              null, 2,
            ),
          );
          console.log(
            `${name}(e2e): ${out.meta.success ? `md ${out.md.length} 字符` : `失败 ${out.meta.error}`}（端到端 ${e2e.ms.total + parseMs}ms = 导航等待 ${e2e.ms.total} + 解析 ${parseMs}）`,
          );
        } catch (err) {
          console.error(`${name}(e2e) 失败: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    await runJina(c, url);
    reportCase(c, url);
  }
} finally {
  await pool.close().catch(() => {});
}

if (skipped.length) {
  console.log(`\n跳过用例: ${skipped.map((s) => `${s.case}（${s.reason}）`).join('、')}`);
}
if (!noReport && caseReports.length) {
  console.log('\n========== 对比报告 ==========');
  console.log(formatReport(caseReports));
  console.log('\n========== 聚合 ==========');
  console.log(JSON.stringify(aggregate(caseReports), null, 2));
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(BENCH_DIR, 'bench-report.json'),
    JSON.stringify(
      { schemaVersion: 1, generatedAt: new Date().toISOString(), cases: caseReports, aggregate: aggregate(caseReports), aggregateBySuite: aggregateBySuite(caseReports) },
      null, 2,
    ),
  );
  console.log(`\n报告已写入 ${path.join(BENCH_DIR, 'bench-report.json')}`);
  const htmlPath = writeHtmlReport(BENCH_DIR, caseReports);
  console.log(`HTML 报告（含历史趋势）: ${htmlPath}`);
}
