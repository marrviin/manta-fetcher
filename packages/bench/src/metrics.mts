/**
 * bench 指标层（纯函数，无 IO）：
 * 归一化 / md→纯文本 / 句子召回 / 字符 bigram P·R·F1 / 结构计数 / 金样指标。
 * 参考系：pageText.txt（快照时可见文本）+ dom-stats.json + gold.json（可选）。
 * 中文按字符二元组（不分词）；所有匹配基于 norm() 后的串。
 */

export const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '');

/** md → 纯文本（去 md 语法，供包含性匹配；图片整体删除避免 alt 干扰段落连续性） */
export function mdToPlain(md: string): string {
  return md
    .replace(/```[a-zA-Z0-9+#.-]*\n([\s\S]*?)```/g, '\n$1\n') // fence → 保留代码文本
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片删除
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 → 链接文本
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\|/gm, '')
    .replace(/\|/g, '')
    .replace(/[*_`~]/g, '');
}

/** 句子切分：先按句末标点/换行/表格列切分，再 norm（中文按句读、英文按行）；长度 ≥12 才参与召回 */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n|;；]/)
    .map((s) => norm(s))
    .filter((s) => s.length >= 12);
}

/** 句子召回率：参考句被引擎纯文本包含的比例 */
export function sentenceRecall(refText: string, enginePlain: string): { ratio: number; hits: number; total: number; missed: string[] } {
  const sentences = splitSentences(refText);
  const plain = norm(enginePlain);
  const hits = sentences.filter((s) => plain.includes(s));
  return {
    ratio: sentences.length ? hits.length / sentences.length : 0,
    hits: hits.length,
    total: sentences.length,
    missed: sentences.filter((s) => !plain.includes(s)),
  };
}

/** 归一化串的字符 bigram 多重集 */
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

/** 字符 bigram P/R/F1：candidate 相对 reference（多重集交并，中文按字） */
export function bigramPrf(candidate: string, reference: string): Prf {
  const c = bigrams(norm(candidate));
  const r = bigrams(norm(reference));
  if (!c.size || !r.size) return { precision: 0, recall: 0, f1: 0 };
  let inter = 0;
  let cTotal = 0;
  let rTotal = 0;
  for (const v of c.values()) cTotal += v;
  for (const v of r.values()) rTotal += v;
  for (const [g, v] of c) {
    const rv = r.get(g);
    if (rv) inter += Math.min(v, rv);
  }
  const precision = inter / cTotal;
  const recall = inter / rTotal;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

/** 引擎 md 的结构计数（正则统计，供与 dom-stats 对比） */
export function mdStructure(md: string): {
  headings: number;
  images: number;
  links: number;
  fences: number;
  tableRows: number;
  plainChars: number;
} {
  return {
    headings: (md.match(/^#{1,6}\s+/gm) ?? []).length,
    images: (md.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length,
    links: (md.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length,
    fences: (md.match(/^\s*```/gm) ?? []).length / 2,
    tableRows: (md.match(/^\|.+\|$/gm) ?? []).length,
    plainChars: norm(mdToPlain(md)).length,
  };
}

export interface DomStats {
  headings: number;
  images: number;
  links: number;
  tables: number;
  textChars: number;
}

export interface GoldData {
  title: string;
  headings: { level: number; text: string }[];
  paragraphs: string[];
  images: string[];
  noise_examples: string[];
  /** 理解层（旧 gold 可能没有） */
  key_facts?: string[];
  qa?: { question: string; answer: string }[];
  pageTextHash: string;
}

/** 引擎 md → 候选段落单元：空行分块、fence 块整块、归一化 */
export function mdParagraphUnits(md: string): string[] {
  const units: string[] = [];
  const blocks = md.split(/\n\s*\n/);
  let inFence = false;
  let fenceBuf: string[] = [];
  for (const b of blocks) {
    if (/^\s*```/.test(b) || inFence) {
      fenceBuf.push(b);
      if ((b.match(/```/g) ?? []).length % 2 === 1) inFence = !inFence;
      if (!inFence) {
        units.push(norm(mdToPlain(fenceBuf.join('\n'))));
        fenceBuf = [];
      }
      continue;
    }
    const u = norm(mdToPlain(b));
    if (u) units.push(u);
  }
  if (fenceBuf.length) units.push(norm(mdToPlain(fenceBuf.join('\n'))));
  return units;
}

/** 段落命中：归一化串双向包含（≥30 字符，防琐碎块误判） */
function unitMatch(a: string, b: string): boolean {
  if (Math.min(a.length, b.length) < 10) return false;
  const minOverlap = Math.min(30, Math.min(a.length, b.length));
  return (
    (a.includes(b) || b.includes(a)) &&
    Math.min(a.length, b.length) >= minOverlap
  );
}

export interface GoldMetrics {
  content: Prf & { goldUnits: number; engineUnits: number };
  headingRecall: { ratio: number; hits: number; total: number };
  imageRecall: { ratio: number; hits: number; total: number };
  noiseRate: { ratio: number; hits: number; total: number };
}

/** 图片 URL 匹配：比较 pathname 末两段（容忍易变 query/signature） */
function imgPathKey(url: string): string {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return segs.slice(-2).join('/');
  } catch {
    return url;
  }
}

/** 关键事实召回：gold.key_facts（原文措辞的原子事实）被引擎纯文本包含的比例 */
export function keyFactRecall(
  enginePlain: string,
  keyFacts: string[],
): { ratio: number; hits: number; total: number; missed: string[] } {
  const plain = norm(enginePlain);
  const facts = keyFacts.filter((f) => norm(f).length >= 4);
  const missed = facts.filter((f) => !plain.includes(norm(f)));
  return { ratio: facts.length ? (facts.length - missed.length) / facts.length : 1, hits: facts.length - missed.length, total: facts.length, missed };
}

export function goldMetrics(md: string, gold: GoldData): GoldMetrics {
  const engineUnits = mdParagraphUnits(md).filter((u) => u.length >= 10);
  // 金标单元 = 段落 + 标题：标题是标注过的真实内容，引擎正确输出小节标题不应被
  // contentP 记为不精确（此前标题单元只有碰巧被折叠进段落才能匹配，BR 切分修复后
  // 标题独立成块，weixin P 虚降 1.0 → 0.812 暴露了该口径缺陷）
  const goldUnits = [
    ...new Set(
      [...gold.paragraphs.map((p) => norm(p)), ...gold.headings.map((h) => norm(h.text))].filter(Boolean),
    ),
  ].filter((g) => g.length >= 10); // <10 字符单元低于 unitMatch 双向下限，匹配不可能成立，不入分母

  let covered = 0;
  for (const g of goldUnits) {
    if (g.length >= 10 && engineUnits.some((e) => unitMatch(e, g))) covered++;
  }
  let precise = 0;
  for (const e of engineUnits) {
    if (goldUnits.some((g) => unitMatch(e, g))) precise++;
  }
  const p = engineUnits.length ? precise / engineUnits.length : 0;
  const r = goldUnits.length ? covered / goldUnits.length : 0;

  const headLines = [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => norm(m[1]));
  const headHits = gold.headings.filter((h) => {
    const t = norm(h.text);
    return headLines.some((l) => l.includes(t) || t.includes(l));
  });

  const mdImgKeys = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => imgPathKey(m[1]));
  const imgHits = gold.images.filter((g) => {
    const k = imgPathKey(g);
    return k && mdImgKeys.some((m) => m.includes(k) || k.includes(m));
  });

  const noiseHits = engineUnits.filter((e) =>
    gold.noise_examples.some((n) => {
      const t = norm(n);
      return t.length >= 8 && (e.includes(t) || t.includes(e));
    }),
  );

  return {
    content: { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0, goldUnits: goldUnits.length, engineUnits: engineUnits.length },
    headingRecall: { ratio: gold.headings.length ? headHits.length / gold.headings.length : 1, hits: headHits.length, total: gold.headings.length },
    imageRecall: { ratio: gold.images.length ? imgHits.length / gold.images.length : 1, hits: imgHits.length, total: gold.images.length },
    noiseRate: { ratio: engineUnits.length ? noiseHits.length / engineUnits.length : 0, hits: noiseHits.length, total: engineUnits.length },
  };
}

export const pct = (v: number): string => `${Math.round(v * 100)}%`;
export const fmtPrf = (v: Prf): string => `P${pct(v.precision)} R${pct(v.recall)} F1${pct(v.f1)}`;
