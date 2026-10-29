/**
 * Markdown 还原度评估：独立于采集管线，直接从原站 DOM 提取基线，
 * 与已落盘 md 逐项比对（标题/段落/列表/代码块/图片/句子覆盖）。
 *
 * 用法: tsx packages/mcp/scripts/eval-fidelity.mts
 * 输入: CASES（下方硬编码三个场景各一篇，md 从 cache/articles 统一布局读取最新一篇）
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

interface Case {
  name: string;
  siteDir: string; // cache/articles/<siteDir> 下取最新 md
  url?: string; // 缺省从 md 头注释解析
  pick?: (fname: string) => boolean;
  mainSel: string;
  removeSels: string[];
  ua?: string;
}

const CASES: Case[] = [
  {
    name: '掘金文章(表格+代码)',
    siteDir: 'juejin',
    pick: (f) => f.includes('01-'),
    mainSel: '.markdown-body',
    removeSels: ['.article-suspended-panel', '.copyright', 'pre + div'],
  },
  {
    name: '微信文章(搜狗)',
    siteDir: 'weixin-article',
    mainSel: '#js_content',
    removeSels: ['#js_pc_qr_code', '.qr_code_pc'],
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  },
  {
    name: 'AIBase新闻',
    siteDir: 'aibase-article',
    mainSel: 'article',
    removeSels: ['article nav', "article a[href*='/zh/news']", 'article h1 + div', 'article .borderTop'],
  },
];

const norm = (s: string) => s.replace(/\s+/g, '');
const FenceRe = /```[a-zA-Z0-9+#.-]*\n?/g;

/** md → 纯文本（去 md 语法，供包含性匹配；图片整体删除避免 alt 干扰段落连续性） */
function mdToPlain(md: string): string {
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

interface Baseline {
  headings: { level: number; text: string }[];
  paras: string[];
  lis: string[];
  pres: string[];
  tables: number;
  imgs: string[];
  links: number;
  fullText: string;
}

async function evalCase(c: Case): Promise<string> {
  // 1. 找到该站点最新落盘的 md，从文件头注释解析 url
  const siteDir = path.resolve('cache/articles', c.siteDir);
  const dateDirs = fs.readdirSync(siteDir).sort();
  const latest = dateDirs.flatMap((d) => fs.readdirSync(path.join(siteDir, d)).filter((f) => f.endsWith('.md') && !f.endsWith('.meta.json') && (c.pick ? c.pick(f) : true)).map((f) => path.join(siteDir, d, f))).sort().pop();
  if (!latest) throw new Error(`${c.siteDir}: 未找到已落盘 md`);
  const md = fs.readFileSync(latest, 'utf8');
  const url = c.url ?? md.match(/<!-- title:[^|]*\| url: ([^|]+?) \| site:/)?.[1];
  if (!url) throw new Error('无法解析原文 URL');

  // 2. 独立访问原站，提取基线（应用与 profile 相同的 remove 规则）
  const b = await chromium.launch();
  const ctx = await b.newContext({ userAgent: c.ua });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(3000);
  const base = await page.evaluate(({ mainSel, removeSels }) => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (typeof g.__name !== 'function') g.__name = (fn: unknown) => fn;
    const el = document.querySelector(mainSel);
    if (!el) return null;
    for (const sel of removeSels) {
      try {
        el.querySelectorAll(sel).forEach((e) => e.remove());
      } catch { /* ignore */ }
    }
    const visible = (e: Element): boolean => {
      const cs = getComputedStyle(e);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const isVisible = visible;
    const imgs = new Set<string>();
    for (const img of Array.from(el.querySelectorAll('img'))) {
      let src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) {
        for (const a of ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc']) {
          const v = img.getAttribute(a);
          if (v) { src = v; break; }
        }
      }
      if (!src || src.startsWith('data:')) continue;
      try { imgs.add(new URL(src, document.baseURI).href); } catch { /* skip */ }
    }
    return {
      headings: Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible).map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent || '').trim() })).filter((h) => h.text),
      paras: Array.from(el.querySelectorAll('p')).filter(visible).map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length > 15),
      lis: Array.from(el.querySelectorAll('li')).filter(visible).map((li) => (li.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t.length > 4),
      pres: Array.from(el.querySelectorAll('pre')).filter(visible).map((p) => (p.textContent || '').trim()).filter(Boolean),
      tables: el.querySelectorAll('table').length,
      imgs: [...imgs],
      links: el.querySelectorAll('a[href]').length,
      fullText: (el as HTMLElement).innerText || '',
    };
  }, { mainSel: c.mainSel, removeSels: c.removeSels });
  await b.close();
  if (!base) return `${c.name}: 原站 mainSel(${c.mainSel}) 未命中`;

  // 3. 逐项比对
  const plain = norm(mdToPlain(md));
  const mdNorm = norm(md);

  const headLines = [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => norm(m[1]));
  const headMiss = base.headings.filter((h) => !headLines.some((l) => l.includes(norm(h.text)) || norm(h.text).includes(l)));
  const paraMiss = base.paras.filter((p) => !plain.includes(norm(p)));
  const liMiss = base.lis.filter((t) => !plain.includes(norm(t)));
  const preMiss = base.pres.filter((t) => !mdNorm.includes(norm(t)));
  const mdFences = (md.match(/^\s*```/gm) ?? []).length / 2;
  const mdImgs = (md.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length;
  const mdLocalImgs = (md.match(/!\[[^\]]*\]\((?!https?:)([^)]+)\)/g) ?? []).length;

  // 句子级覆盖（信息完整性核心指标）
  // 细粒度切分：句末标点 + 换行 + 表格列，避免把整行 DOM 串成一句造成假阴性
  const sentences = base.fullText
    .split(/[。！？!?\n|]/)
    .map((s) => norm(s))
    .filter((s) => s.length >= 12);
  const sentHit = sentences.filter((s) => plain.includes(s) || mdNorm.includes(s));

  const fmtPct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}% (${n}/${d})`);
  const short = (s: string, n = 42) => (s.length > n ? s.slice(0, n) + '…' : s);

  let out = `\n===== ${c.name} =====\nmd: ${path.relative(process.cwd(), latest)}\n原文: ${url.slice(0, 90)}\n`;
  out += `├ 标题     原文 ${base.headings.length} → md 命中 ${base.headings.length - headMiss.length}    ${headMiss.length ? '缺失: ' + headMiss.slice(0, 4).map((h) => short(h.text, 26)).join(' | ') : ''}\n`;
  out += `├ 段落     原文 ${base.paras.length} → 命中 ${fmtPct(base.paras.length - paraMiss.length, base.paras.length)}${paraMiss.length ? '\n│   缺失段落: ' + paraMiss.slice(0, 3).map((p) => short(p)).join('\n│             ') : ''}\n`;
  out += `├ 列表项   原文 ${base.lis.length} → 命中 ${fmtPct(base.lis.length - liMiss.length, base.lis.length)}\n`;
  out += `├ 代码块   原文 ${base.pres.length} → md fence ${mdFences}, 文本全命中 ${base.pres.length - preMiss.length}\n`;
  out += `├ 表格     原文 ${base.tables}\n`;
  out += `├ 图片     原文 ${base.imgs.length} → md ${mdImgs}(本地 ${mdLocalImgs})\n`;
  out += `├ 链接     原文 <a> ${base.links}\n`;
  out += `├ 文本量   原文 ${base.fullText.length} 字符 → md 纯文本 ${plain.length}\n`;
  out += `└ 句子覆盖 ${fmtPct(sentHit.length, sentences.length)}${sentences.length - sentHit.length ? '\n    未命中句子: ' + sentences.filter((s) => !sentHit.includes(s)).slice(0, 4).map((s) => short(s, 50)).join('\n                ') : ''}\n`;
  return out;
}

const results: string[] = [];
for (const c of CASES) {
  try {
    results.push(await evalCase(c));
  } catch (e) {
    results.push(`\n===== ${c.name} =====\n评估失败: ${e instanceof Error ? e.message : e}\n`);
  }
}
console.log(results.join(''));
process.exit(0);
