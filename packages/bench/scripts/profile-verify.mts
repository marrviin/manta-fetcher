/**
 * Profile 单点验证器（profile 生成闭环的执行端）：
 *   tsx packages/bench/scripts/profile-verify.mts --url <url> [--profile <name>] [--rounds <n>]
 * 对任意 URL 用指定 profile（缺省 generic）跑一次与 bench 相同的采集 + 指标，输出
 * 量化体检表与 PASS/FAIL 判定：句子召回、bigram F1、字符比、结构计数对齐。
 * 供 agent 起草 profile 后自验迭代（改 YAML → 重跑本命令 → 看失败行 → 再改），
 * 工件落 ~/.manta-fetcher/cache/bench/verify-<slug>/，不进 case 基准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptureResult } from '../src/capture.mts';

// profiles/ 按 cwd 解析（packages/core/src/paths.ts）：不在仓库根则先切过去再动态加载
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (!fs.existsSync(path.join(repoRoot, 'profiles'))) {
  console.error(`未找到 ${path.join(repoRoot, 'profiles')}，请在 manta-fetcher 仓库内运行`);
  process.exit(1);
}
if (process.cwd() !== repoRoot) process.chdir(repoRoot);

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const url = arg('--url');
const profileName = arg('--profile') ?? null;
if (!url) {
  console.error('用法: profile-verify.mts --url <url> [--profile <name>]');
  console.error(`已有 profile: ${fs.readdirSync(path.join(repoRoot, 'profiles')).filter((f) => f.endsWith('.yaml')).join(', ')}`);
  process.exit(1);
}
const slug = `${(profileName ?? 'generic').replace(/[^a-z0-9-]/gi, '')}-${Date.now().toString(36)}`;

const { BrowserPool, FetchEngine, ProfileRegistry, effectiveProfile, profilesDir } = await import('@manta-fetcher/core');
const { captureCase, caseDir } = await import('../src/capture.mts');
const { buildCaseReport } = await import('../src/report.mts');

// dev 脚本：额外扫描仓库根模板 profiles/（与 bench-run 一致）
const registry = new ProfileRegistry([path.join(repoRoot, "profiles"), profilesDir]);
await registry.reload();
if (profileName && !registry.byName(profileName)) {
  console.error(`✗ profile 不存在: ${profileName}（写好 profiles/<name>.yaml 后重跑；YAML 语法错误也会表现为查不到）`);
  process.exit(1);
}

const pool = new BrowserPool(1);
const engine = new FetchEngine(pool);
try {
  const c = { name: `verify-${slug}`, url, profileName, kind: 'direct' as const };
  let cap: CaptureResult | null = null;
  try {
    cap = await captureCase(c, registry, pool);
    const dir = caseDir(c.name);
    fs.writeFileSync(path.join(dir, 'engines', 'manta.md'), cap.manta.md);
    fs.writeFileSync(
      path.join(dir, 'engines', 'manta.meta.json'),
      JSON.stringify(cap.manta.meta, null, 2),
    );
  } catch (err) {
    console.error(`✗ 采集失败: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const rep = buildCaseReport(c.name, url, profileName);
  if (!rep || !rep.engines.length) {
    console.error('✗ 报告生成失败（缓存不完整）');
    process.exit(1);
  }
  const e = rep.engines.find((x) => x.engine === 'manta');
  if (!e || !e.success) {
    console.error(`✗ manta 输出失败: ${e?.error ?? '未知'}`);
    process.exit(1);
  }

  // 体检判定（阈值与 bench 报告语义一致）
  const recall = e.sentenceRecall.ratio;
  const f1 = e.bigram.f1;
  const ratio = e.charRatio;
  const checks: { item: string; value: string; pass: boolean; hint: string }[] = [
    {
      item: '句子召回（相对参考系）',
      value: `${Math.round(recall * 100)}% (${e.sentenceRecall.hits}/${e.sentenceRecall.total})`,
      pass: recall >= 0.85,
      hint: '低召回 → mainContent 框小了/该滚动的正文没渲染；查 coreText.txt 与 engines/manta.md 差异',
    },
    {
      item: 'bigram F1（对参考系）',
      value: `${Math.round(f1 * 100)}%`,
      pass: f1 >= 0.8,
      hint: '低 F1 高召回 → 输出混入噪音 → 收紧 remove；低 F1 低召回 → 内容缺失',
    },
    {
      item: '字符比（输出/参考系）',
      value: ratio.toFixed(2),
      pass: ratio >= 0.5 && ratio <= 1.3,
      hint: '≪1 丢内容；≫1 噪音多 → 加 remove 规则或收窄 mainContent',
    },
    {
      item: '标题命中',
      value: `${e.structure.md.headings}/${e.structure.dom.headings}（dom 为全页数）`,
      pass: e.structure.dom.headings === 0 || e.structure.md.headings >= 1,
      hint: '输出无标题 → profile 的 title 选择器未命中',
    },
    {
      item: '图片保留（内容图）',
      value: `${e.structure.md.images}/${e.structure.dom.coreImages ?? e.structure.dom.images}（参考为 mainContent 内短边≥80 的内容图，无 profile 时为全页数）`,
      pass:
        (e.structure.dom.coreImages ?? e.structure.dom.images) === 0 ||
        e.structure.md.images >= 1,
      hint: '输出 0 图且主内容区有内容图 → 懒加载属性未覆盖或 mainContent 范围错了',
    },
  ];

  console.log(`\n=== profile-verify: ${profileName ?? 'generic'} @ ${url} ===`);
  console.log(`标题: ${cap.manta.title}\n节点: ${cap.manta.layout.nodes.length} · md ${cap.manta.md.length} 字符（warm ${cap.manta.meta.ms.warm}ms collect ${cap.manta.meta.ms.collect}ms）`);
  for (const c2 of checks) {
    console.log(`${c2.pass ? '✓' : '✗'} ${c2.item}: ${c2.value}${c2.pass ? '' : `\n    → ${c2.hint}`}`);
  }
  const failed = checks.filter((c2) => !c2.pass);
  console.log(failed.length ? `\n判定: FAIL（${failed.length} 项未过 → 修正 YAML 后重跑本命令）` : '\n判定: PASS');
  process.exit(failed.length ? 1 : 0);
} finally {
  await pool.close().catch(() => {});
}
