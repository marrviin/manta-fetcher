/**
 * 金样生成入口（高成本、一次性、缓存复用）：
 *   tsx packages/bench/scripts/bench-gold.mts --case <name>          # API 或 bundle 模式
 *   tsx packages/bench/scripts/bench-gold.mts --all                  # 全部 case
 *   tsx packages/bench/scripts/bench-gold.mts --case <name> --api    # 强制 API 模式
 *   tsx packages/bench/scripts/bench-gold.mts --case <name> --import gold-raw.txt  # 导入 bundle 输出
 * 优先级：已有新鲜 gold.json → 直接复用；否则按模式生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BENCH_CASES } from '../src/cases.mts';
import { caseDir } from '../src/capture.mts';
import { buildGoldPrompt, callAnthropic, loadFreshGold, pageTextHash, parseGoldOutput } from '../src/gold.mts';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const onlyCase = arg('--case');
const importFile = arg('--import');
const forceApi = process.argv.includes('--api');
const all = process.argv.includes('--all');
if (!onlyCase && !all) {
  console.error(`用法: bench-gold.mts --case <name> | --all | --case <name> --import <file> [--api]`);
  console.error(`case: ${BENCH_CASES.map((c) => c.name).join(', ')}`);
  process.exit(1);
}
const selected = BENCH_CASES.filter((c) => all || c.name === onlyCase);

let exitCode = 0;
for (const c of selected) {
  const dir = caseDir(c.name);
  const textPath = path.join(dir, 'pageText.txt');
  if (!fs.existsSync(textPath)) {
    console.error(`✗ ${c.name}: 无 pageText.txt，请先跑 bench-run.mts --case ${c.name}`);
    exitCode = 1;
    continue;
  }
  const pageText = fs.readFileSync(textPath, 'utf8');
  const hash = pageTextHash(pageText);

  const fresh = loadFreshGold(dir, pageText);
  if (fresh && !importFile) {
    console.log(`✓ ${c.name}: gold.json 已存在且新鲜（${fresh.paragraphs.length} 段落），跳过`);
    continue;
  }

  const url = fresh?.url ?? c.url;
  if (importFile) {
    const raw = fs.readFileSync(path.resolve(importFile), 'utf8');
    try {
      const gold = parseGoldOutput(raw, { case: c.name, url, hash, pageUrl: url });
      fs.writeFileSync(path.join(dir, 'gold.json'), JSON.stringify(gold, null, 2));
      console.log(`✓ ${c.name}: 金样导入成功（标题 ${gold.headings.length} / 段落 ${gold.paragraphs.length} / 图片 ${gold.images.length} / 噪音例 ${gold.noise_examples.length}）`);
    } catch (err) {
      console.error(`✗ ${c.name}: ${err instanceof Error ? err.message : err}`);
      exitCode = 1;
    }
    continue;
  }

  const prompt = buildGoldPrompt(c.name, url, pageText);
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  if (hasKey || forceApi) {
    if (!hasKey) {
      console.error(`✗ ${c.name}: --api 需要设置 ANTHROPIC_API_KEY`);
      exitCode = 1;
      continue;
    }
    const model = process.env.BENCH_GOLD_MODEL || 'claude-sonnet-4-5';
    console.log(`… ${c.name}: 调用 API（${model}，页面文本 ${pageText.length} 字符）`);
    try {
      const raw = await callAnthropic(prompt, model);
      const gold = parseGoldOutput(raw, { case: c.name, url, hash, pageUrl: url });
      gold.model = model;
      gold.generatedAt = new Date().toISOString();
      fs.writeFileSync(path.join(dir, 'gold.json'), JSON.stringify(gold, null, 2));
      console.log(`✓ ${c.name}: 金样生成成功（标题 ${gold.headings.length} / 段落 ${gold.paragraphs.length} / 图片 ${gold.images.length} / 噪音例 ${gold.noise_examples.length}）`);
    } catch (err) {
      console.error(`✗ ${c.name}: ${err instanceof Error ? err.message : err}`);
      console.error(`  兜底：prompt 已可导出，用 bundle 模式人工标注后 --import 回填`);
      fs.writeFileSync(path.join(dir, 'gold-prompt.txt'), prompt);
      exitCode = 1;
    }
  } else {
    const p = path.join(dir, 'gold-prompt.txt');
    fs.writeFileSync(p, prompt);
    console.log(`✓ ${c.name}: bundle 模式 — prompt 已写入 ${p}`);
    console.log(`  将其贴给任意大模型，把纯 JSON 输出存为文件后执行:`);
    console.log(`  tsx packages/bench/scripts/bench-gold.mts --case ${c.name} --import <输出文件>`);
  }
}
process.exit(exitCode);
