/**
 * bench 报告层：从缓存工件（engines/*.md、dom-stats.json、pageText.txt、gold.json）
 * 重算全部指标并格式化。bench-run（在线）与 bench-report（离线重算）共用。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  bigramPrf,
  fmtPrf,
  goldMetrics,
  mdStructure,
  mdToPlain,
  keyFactRecall,
  pct,
  sentenceRecall,
  type DomStats,
  type GoldData,
  type Prf,
} from './metrics.mts';
import { caseDir } from './capture.mts';
import { loadFreshGold } from './gold.mts';

export interface EngineReport {
  engine: string;
  success: boolean;
  error?: string;
  ms: Record<string, number>;
  profileAware: boolean;
  sentenceRecall: { ratio: number; hits: number; total: number };
  bigram: Prf;
  structure: { md: ReturnType<typeof mdStructure>; dom: DomStats };
  charRatio: number;
  gold?: {
    contentF1: number;
    contentP: number;
    contentR: number;
    headingRecall: number;
    headingTotal: number;
    imageRecall: number;
    imageTotal: number;
    noiseRate: number;
    /** 理解层：关键事实召回（自动包含匹配） */
    keyFactRecall?: number;
    keyFactTotal?: number;
    /** 理解层：QA 理解准确率（LLM 裁判，结果缓存于 engines/<engine>.qa.json） */
    qaAccuracy?: number;
    qaTotal?: number;
  };
}

export interface CaseReport {
  case: string;
  url: string;
  profileName: string | null;
  gold: { present: boolean; stale: boolean };
  engines: EngineReport[];
  /** 端到端层：基线各自真实流程（自行导航、无预热、无懒加载回填）的结果，质量相对各自看到的页面 */
  e2e?: {
    engine: string;
    success: boolean;
    error?: string;
    ms: number;
    sentenceRecall: { ratio: number; hits: number; total: number };
    bigramF1: number;
    charRatio: number;
  }[];
  /** 引擎间 bigram-F1 一致性矩阵（双向对比） */
  agreement: Record<string, number>;
}

/** 从缓存目录重算单 case 报告（不出网）。缺引擎文件则该引擎标记未跑 */
export function buildCaseReport(name: string, url: string, profileName: string | null): CaseReport | null {
  const dir = caseDir(name);
  if (!fs.existsSync(dir)) return null;

  const statsPath = path.join(dir, 'dom-stats.json');
  const textPath = path.join(dir, 'pageText.txt');
  if (!fs.existsSync(statsPath) || !fs.existsSync(textPath)) return null;
  const domStats: DomStats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  const pageText = fs.readFileSync(textPath, 'utf8');
  // 参考系：有 profile 的用例用 mainContent 的 DOM 参考文本（coreText.txt，采集时独立提取），
  // 剔除推荐流/评论区对召回分母的污染；无 profile 用整页文本。金样仍锚定整页 pageText。
  const corePath = path.join(dir, 'coreText.txt');
  const refText = fs.existsSync(corePath) ? fs.readFileSync(corePath, 'utf8') || pageText : pageText;
  const refChars = refText.replace(/\s+/g, '').length;

  // 金样装载：hash 不匹配时按正文段落覆盖率判定（≥90% 命中视为计数抖动并自愈，否则 stale）
  let gold: GoldData | null = null;
  let goldStale = false;
  if (loadFreshGold(dir, pageText)) {
    gold = JSON.parse(fs.readFileSync(path.join(dir, 'gold.json'), 'utf8')) as GoldData;
  } else if (fs.existsSync(path.join(dir, 'gold.json'))) {
    goldStale = true;
  }

  const engineDir = path.join(dir, 'engines');
  const engineFiles = fs.existsSync(engineDir)
    ? fs.readdirSync(engineDir).filter((f) => f.endsWith('.md') && !f.endsWith('.e2e.md'))
    : [];

  const engines: EngineReport[] = engineFiles.map((f) => {
    const engine = f.replace(/\.md$/, '');
    const md = fs.readFileSync(path.join(engineDir, f), 'utf8');
    const metaPath = path.join(engineDir, `${engine}.meta.json`);
    const meta = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      : { success: true, ms: {}, profileAware: false };

    const plain = mdStructure(md).plainChars;
    const rep: EngineReport = {
      engine,
      success: meta.success ?? true,
      error: meta.error,
      ms: meta.ms ?? {},
      profileAware: meta.profileAware ?? false,
      sentenceRecall: { ratio: 0, hits: 0, total: 0 },
      // bigram 用去语法纯文本：md 链接的 URL 是投影产物而非内容噪音，原始串会虚扣精度
      bigram: bigramPrf(mdToPlain(md), refText),
      structure: { md: mdStructure(md), dom: domStats },
      charRatio: refChars ? plain / refChars : 0,
    };
    if (rep.success) {
      const sr = sentenceRecall(refText, md);
      rep.sentenceRecall = { ratio: sr.ratio, hits: sr.hits, total: sr.total };
      if (gold) {
        const gm = goldMetrics(md, gold);
        rep.gold = {
          contentF1: gm.content.f1,
          contentP: gm.content.precision,
          contentR: gm.content.recall,
          headingRecall: gm.headingRecall.ratio,
          headingTotal: gm.headingRecall.total,
          imageRecall: gm.imageRecall.ratio,
          imageTotal: gm.imageRecall.total,
          noiseRate: gm.noiseRate.ratio,
        };
        // 理解层：关键事实召回（自动）；QA 读裁判缓存（bench-run 在线判或人工回填）
        const kf = keyFactRecall(md, gold.key_facts ?? []);
        if (kf.total) {
          rep.gold.keyFactRecall = kf.ratio;
          rep.gold.keyFactTotal = kf.total;
        }
        const qaPath = path.join(engineDir, `${engine}.qa.json`);
        if (fs.existsSync(qaPath)) {
          try {
            const qa = JSON.parse(fs.readFileSync(qaPath, 'utf8'));
            if (typeof qa.accuracy === 'number' && qa.total > 0) {
              rep.gold.qaAccuracy = qa.accuracy;
              rep.gold.qaTotal = qa.total;
            }
          } catch {
            /* 坏文件当无裁判结果 */
          }
        }
      }
    }
    return rep;
  });

  // 一致性矩阵：引擎两两 bigram-F1（i 相对 j）
  const agreement: Record<string, number> = {};
  for (const a of engines) {
    for (const b of engines) {
      if (a.engine >= b.engine) continue;
      const mdA = fs.readFileSync(path.join(engineDir, `${a.engine}.md`), 'utf8');
      const mdB = fs.readFileSync(path.join(engineDir, `${b.engine}.md`), 'utf8');
      agreement[`${a.engine}~${b.engine}`] = Number(bigramPrf(mdToPlain(mdA), mdToPlain(mdB)).f1.toFixed(4));
    }
  }

  // 端到端层：engines/<engine>.e2e.md + e2e-pageText.txt（基线自采快照的可见文本）
  const e2e: NonNullable<CaseReport['e2e']> = [];
  const e2eFiles = fs.existsSync(engineDir)
    ? fs.readdirSync(engineDir).filter((x) => x.endsWith('.e2e.md'))
    : [];
  for (const f of e2eFiles) {
    const engine = f.replace(/\.e2e\.md$/, '');
    const md = fs.readFileSync(path.join(engineDir, f), 'utf8');
    const metaPath = path.join(engineDir, `${engine}.e2e.meta.json`);
    const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : { success: true, ms: { total: 0 } };
    const refPath = path.join(dir, 'e2e-pageText.txt');
    const refText = fs.existsSync(refPath) ? fs.readFileSync(refPath, 'utf8') : '';
    const refChars = refText.replace(/\s+/g, '').length;
    const sr = refText ? sentenceRecall(refText, md) : { ratio: 0, hits: 0, total: 0 };
    e2e.push({
      engine,
      success: meta.success ?? true,
      error: meta.error,
      ms: meta.ms?.total ?? 0,
      sentenceRecall: sr,
      bigramF1: refText ? bigramPrf(mdToPlain(md), refText).f1 : 0,
      charRatio: refChars ? mdStructure(md).plainChars / refChars : 0,
    });
  }

  return { case: name, url, profileName, gold: { present: !!gold, stale: goldStale }, engines, e2e: e2e.length ? e2e : undefined, agreement };
}

const pctCell = (v: number | undefined, total?: number): string =>
  v === undefined ? '—' : total !== undefined && !total ? '—' : pct(v);

/** 控制台 markdown 报告（含图例说明） */
export function formatReport(reports: CaseReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(
      `\n### ${r.case}（profile: ${r.profileName ?? '无(generic)'}${r.profileName ? ' · 参考系=主内容区' : ' · 参考系=整页'}）`,
    );
    if (r.gold.stale) lines.push(`> ⚠ gold.json 已过期（页面文本变化），金样指标跳过`);
    const hasGold = r.engines.some((e) => e.gold);
    const head = hasGold
      ? '| 引擎 | 句子召回 | bigram F1 | 内容 P/R/F1 | 标题召回 | 图片召回 | 噪音率 | 事实/QA | 字符比 | 耗时ms |'
      : '| 引擎 | 句子召回 | bigram F1 | 字符比 | 耗时ms |';
    lines.push(head);
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const e of r.engines) {
      if (!e.success) {
        lines.push(`| ${e.engine} | ✗ 失败: ${(e.error ?? '').slice(0, 40)} | | | | | | | |`);
        continue;
      }
      const ms = e.ms.total != null ? `${e.ms.total}` : '—';
      if (hasGold) {
        const g = e.gold;
        const understand =
          g && (g.keyFactTotal || g.qaTotal)
            ? `${g.keyFactTotal ? pct(g.keyFactRecall ?? 0) : '—'}/${g.qaTotal ? pct(g.qaAccuracy ?? 0) : '—'}`
            : '—';
        lines.push(
          `| ${e.engine}${e.profileAware ? ' ⭐' : ''} | ${pctCell(e.sentenceRecall.total ? e.sentenceRecall.ratio : undefined, e.sentenceRecall.total)} | ${pct(e.bigram.f1)} | ${g ? `${pct(g.contentP)}/${pct(g.contentR)}/${pct(g.contentF1)}` : '—'} | ${g ? pctCell(g.headingRecall, g.headingTotal) : '—'} | ${g ? pctCell(g.imageRecall, g.imageTotal) : '—'} | ${g ? pctCell(g.noiseRate) : '—'} | ${understand} | ${e.charRatio.toFixed(2)} | ${ms} |`,
        );
      } else {
        lines.push(
          `| ${e.engine}${e.profileAware ? ' ⭐' : ''} | ${pctCell(e.sentenceRecall.total ? e.sentenceRecall.ratio : undefined, e.sentenceRecall.total)} | ${pct(e.bigram.f1)} | ${e.charRatio.toFixed(2)} | ${ms} |`,
        );
      }
    }
    if (r.e2e?.length) {
      const mantaE2e = r.engines.find((e) => e.engine === 'manta');
      lines.push(`\n**端到端对比**（各引擎真实流程：基线自行 goto→networkidle 尽力等待→立即抽取，无预热无懒加载回填；manta 行即其全管线；质量相对各自看到的页面）`);
      lines.push('| 引擎 | 端到端ms | 句子召回 | bigram F1 | 字符比 |');
      lines.push('|---|---|---|---|---|');
      if (mantaE2e?.success) {
        lines.push(
          `| manta | ${mantaE2e.ms.total ?? '—'} | ${pctCell(mantaE2e.sentenceRecall.total ? mantaE2e.sentenceRecall.ratio : undefined, mantaE2e.sentenceRecall.total)} | ${pct(mantaE2e.bigram.f1)} | ${mantaE2e.charRatio.toFixed(2)} |`,
        );
      }
      for (const e of r.e2e) {
        if (!e.success) {
          lines.push(`| ${e.engine} | ${e.ms} | ✗ ${(e.error ?? '').slice(0, 30)} | | |`);
          continue;
        }
        lines.push(
          `| ${e.engine} | ${e.ms} | ${pctCell(e.sentenceRecall.total ? e.sentenceRecall.ratio : undefined, e.sentenceRecall.total)} | ${pct(e.bigramF1)} | ${e.charRatio.toFixed(2)} |`,
        );
      }
    }
    if (Object.keys(r.agreement).length) {
      lines.push(`一致性（bigram F1 两两）: ${Object.entries(r.agreement).map(([k, v]) => `${k}=${pct(v)}`).join('  ')}`);
    }
    // 结构计数明细
    for (const e of r.engines) {
      if (!e.success) continue;
      const s = e.structure;
      lines.push(
        `  ${e.engine}: 标题 ${s.md.headings}/${s.dom.headings} 图片 ${s.md.images}/${s.dom.images} 链接 ${s.md.links}/${s.dom.links} fence ${s.md.fences} 表行 ${s.md.tableRows}（dom 表 ${s.dom.tables}）`,
      );
    }
  }
  lines.push(
    `\n> 图例：⭐=使用站点 profile（mainContent/remove 裁剪，产品能力）；有 profile 的用例参考系=mainContent 的 DOM 文本（句子召回/大 F1/字符比均相对主内容，无推荐流污染）；无 profile 用整页文本（召回分母含噪音，正确降噪会显低，结合一致性矩阵解读）；"事实/QA"为理解层：关键事实召回（自动包含匹配）/QA 理解准确率（LLM 裁判，需 ANTHROPIC_API_KEY 或人工回填 qa.json）；耗时为单次运行，manta 含网络预热（warm/collect/md 拆分见 meta）。`,
  );
  return lines.join('\n');
}

/** 跨 case 聚合（每引擎均值） */
export function aggregate(reports: CaseReport[]): Record<string, Record<string, number>> {
  const acc: Record<string, { sr: number[]; f1: number[]; ms: number[]; ok: number; total: number; goldF1: number[] }> = {};
  for (const r of reports) {
    for (const e of r.engines) {
      const a = (acc[e.engine] ??= { sr: [], f1: [], ms: [], ok: 0, total: 0, goldF1: [] });
      a.total++;
      if (e.success) {
        a.ok++;
        if (e.sentenceRecall.total) a.sr.push(e.sentenceRecall.ratio);
        a.f1.push(e.bigram.f1);
        if (e.ms.total != null) a.ms.push(e.ms.total);
        if (e.gold) a.goldF1.push(e.gold.contentF1);
      }
    }
  }
  const out: Record<string, Record<string, number>> = {};
  for (const [eng, a] of Object.entries(acc)) {
    const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
    out[eng] = {
      successRate: a.total ? a.ok / a.total : 0,
      sentenceRecallAvg: Number(avg(a.sr).toFixed(4)),
      bigramF1Avg: Number(avg(a.f1).toFixed(4)),
      msTotalAvg: Math.round(avg(a.ms)),
      goldContentF1Avg: a.goldF1.length ? Number(avg(a.goldF1).toFixed(4)) : -1,
    };
  }
  return out;
}

/**
 * 分套件聚合：profiled（有 profile 用例）vs generic（通用语料库）。
 * 引擎质量必须分列——有 profile 的分数不能代表任意 URL 上的表现。
 */
export function aggregateBySuite(reports: CaseReport[]): Record<string, Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, Record<string, number>>> = {};
  const profiled = reports.filter((r) => r.profileName);
  const generic = reports.filter((r) => !r.profileName);
  if (profiled.length) out.profiled = aggregate(profiled);
  if (generic.length) out.generic = aggregate(generic);
  return out;
}
