/**
 * bench HTML 报告层：把一次运行的报告 + 历史趋势渲染成单文件 report.html
 * （零依赖：内联 CSS/SVG，无 CDN，离线可看）。历史按 jsonl 追加在 bench-history.jsonl。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CaseReport } from './report.mts';

const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (v: number | undefined): string => (v == null ? '—' : `${Math.round(v * 100)}%`);

export interface EngineRunMetrics {
  sentenceRecall?: number;
  bigramF1?: number;
  goldContentF1?: number;
  noiseRate?: number;
  charRatio?: number;
  success: boolean;
}
export interface HistoryEntry {
  ts: string;
  /** case → engine → 指标 */
  cases: Record<string, Record<string, EngineRunMetrics>>;
  aggregate: Record<string, Record<string, number>>;
}

/** 从一次运行的 reports 构造历史条目（只记成功引擎） */
export function buildHistoryEntry(reports: CaseReport[]): HistoryEntry {
  const cases: HistoryEntry['cases'] = {};
  const sum: Record<string, { n: number; recall: number; f1: number; gold: number; goldN: number; ms: number }> = {};
  for (const r of reports) {
    cases[r.case] = {};
    for (const e of r.engines) {
      cases[r.case][e.engine] = {
        success: e.success,
        sentenceRecall: e.success ? e.sentenceRecall.ratio : undefined,
        bigramF1: e.success ? e.bigram.f1 : undefined,
        goldContentF1: e.success ? e.gold?.contentF1 : undefined,
        noiseRate: e.success ? e.gold?.noiseRate : undefined,
        charRatio: e.success ? e.charRatio : undefined,
      };
      if (!e.success) continue;
      const s = (sum[e.engine] ??= { n: 0, recall: 0, f1: 0, gold: 0, goldN: 0, ms: 0 });
      s.n++;
      s.recall += e.sentenceRecall.ratio;
      s.f1 += e.bigram.f1;
      s.ms += e.ms.total ?? 0;
      if (e.gold) {
        s.gold += e.gold.contentF1;
        s.goldN++;
      }
    }
  }
  const aggregate: HistoryEntry['aggregate'] = {};
  for (const [engine, s] of Object.entries(sum)) {
    aggregate[engine] = {
      successRate: s.n / reports.length,
      sentenceRecallAvg: s.n ? s.recall / s.n : 0,
      bigramF1Avg: s.n ? s.f1 / s.n : 0,
      goldContentF1Avg: s.goldN ? s.gold / s.goldN : -1,
      msTotalAvg: s.n ? s.ms / s.n : 0,
    };
  }
  return { ts: new Date().toISOString(), cases, aggregate };
}

export const historyPath = (dir: string): string => path.join(dir, 'bench-history.jsonl');

export function loadHistory(dir: string): HistoryEntry[] {
  const p = historyPath(dir);
  if (!fs.existsSync(p)) return [];
  const out: HistoryEntry[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

export function appendHistory(dir: string, entry: HistoryEntry): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(historyPath(dir), `${JSON.stringify(entry)}\n`);
}

const ENGINE_COLORS: Record<string, string> = {
  manta: '#2563eb',
  'raw-turndown': '#dc2626',
  'readability-turndown': '#059669',
};
const engineColor = (name: string): string => ENGINE_COLORS[name] ?? '#9333ea';
const shortTs = (ts: string): string => {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 折线图（SVG）：x=运行序次，y=指标；引擎缺该次数据则断线 */
function lineChart(
  history: HistoryEntry[],
  pick: (agg: HistoryEntry['aggregate'][string]) => number | undefined,
  title: string,
  engineNames: string[],
): string {
  const W = 760;
  const H = 230;
  const padL = 44;
  const padR = 16;
  const padT = 30;
  const padB = 34;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const n = Math.max(history.length, 1);
  const x = (i: number): number => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number): number => padT + (1 - Math.max(0, Math.min(1, v))) * ih;

  let grid = '';
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    grid += `<line x1="${padL}" y1="${y(g)}" x2="${W - padR}" y2="${y(g)}" stroke="#e5e7eb"/><text x="${padL - 6}" y="${y(g) + 4}" text-anchor="end" font-size="10" fill="#6b7280">${Math.round(g * 100)}%</text>`;
  }
  let xLabels = '';
  history.forEach((h, i) => {
    if (n > 8 && i % Math.ceil(n / 8) !== 0 && i !== n - 1) return;
    xLabels += `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" font-size="10" fill="#6b7280">${esc(shortTs(h.ts))}</text>`;
  });

  let lines = '';
  let legend = '';
  engineNames.forEach((e, k) => {
    const segs: string[][] = [];
    let cur: string[] = [];
    history.forEach((h, i) => {
      const v = pick(h.aggregate[e]);
      if (v == null || v < 0) {
        if (cur.length) segs.push(cur);
        cur = [];
        return;
      }
      cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      // 单点断段也要画出
      if (cur.length === 1) segs.push(cur);
    });
    if (cur.length) segs.push(cur);
    const color = engineColor(e);
    const lastV = [...history].reverse().map((h) => pick(h.aggregate[e])).find((v) => v != null && v >= 0);
    lines += `<g>${segs
      .map((s) =>
        s.length === 1
          ? `<circle cx="${s[0].split(',')[0]}" cy="${s[0].split(',')[1]}" r="3" fill="${color}"/>`
          : `<polyline points="${s.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`,
      )
      .join('')}</g>`;
    legend += `<span style="color:${color}">— ${esc(e)}${lastV != null && lastV >= 0 ? `（最新 ${Math.round(lastV * 100)}%）` : ''}</span>`;
    void k;
  });

  return `<div class="chart"><h3>${esc(title)}</h3><svg viewBox="0 0 ${W} ${H}" width="100%">${grid}${lines}${xLabels}</svg><div class="legend">${legend}</div></div>`;
}

/** 单 case 对比表 */
function caseTable(r: CaseReport): string {
  const goldCols = r.engines.some((e) => e.gold);
  const head = goldCols
    ? '<tr><th>引擎</th><th>句子召回</th><th>bigram F1</th><th>内容 P/R/F1</th><th>标题召回</th><th>图片召回</th><th>噪音率</th><th>事实/QA</th><th>字符比</th><th>耗时ms</th></tr>'
    : '<tr><th>引擎</th><th>句子召回</th><th>bigram F1</th><th>字符比</th><th>耗时ms</th></tr>';
  const rows = r.engines
    .map((e) => {
      const star = e.profileAware ? ' ⭐' : '';
      if (!e.success) return `<tr><td>${esc(e.engine)}${star}</td><td colspan="${goldCols ? 9 : 4}">✗ ${esc(e.error)}</td></tr>`;
      const g = e.gold;
      const understand =
        g && (g.keyFactTotal || g.qaTotal)
          ? `${g.keyFactTotal ? pct(g.keyFactRecall) : '—'}/${g.qaTotal ? pct(g.qaAccuracy) : '—'}`
          : '—';
      const cells = goldCols
        ? `<td>${pct(e.sentenceRecall.ratio)}</td><td>${pct(e.bigram.f1)}</td><td>${
            g ? `${pct(g.contentP)}/${pct(g.contentR)}/${pct(g.contentF1)}` : '—'
          }</td><td>${g ? (g.headingTotal ? pct(g.headingRecall) : '—') : '—'}</td><td>${g ? (g.imageTotal ? pct(g.imageRecall) : '—') : '—'}</td><td>${g ? pct(g.noiseRate) : '—'}</td><td>${understand}</td><td>${e.charRatio.toFixed(2)}</td><td>${e.ms.total ?? '—'}</td>`
        : `<td>${pct(e.sentenceRecall.ratio)}</td><td>${pct(e.bigram.f1)}</td><td>${e.charRatio.toFixed(2)}</td><td>${e.ms.total ?? '—'}</td>`;
      const note = `标题 ${e.structure.md.headings}/${e.structure.dom.headings} · 图片 ${e.structure.md.images}/${e.structure.dom.images} · 链接 ${e.structure.md.links}/${e.structure.dom.links}`;
      return `<tr><td>${esc(e.engine)}${star}</td>${cells}</tr><!--${esc(note)}-->`;
    })
    .join('');
  const matrix = Object.entries(r.agreement)
    .map(([k, v]) => `${esc(k)}=<b>${pct(v)}</b>`)
    .join('&nbsp;&nbsp;');
  let e2eHtml = '';
  if (r.e2e?.length) {
    const mantaE2e = r.engines.find((e) => e.engine === 'manta');
    const e2eRows = r.e2e
      .map((e) =>
        e.success
          ? `<tr><td>${esc(e.engine)}</td><td>${e.ms}</td><td>${pct(e.sentenceRecall.total ? e.sentenceRecall.ratio : undefined)}</td><td>${pct(e.bigramF1)}</td><td>${e.charRatio.toFixed(2)}</td></tr>`
          : `<tr><td>${esc(e.engine)}</td><td>${e.ms}</td><td colspan="3">✗ ${esc(e.error)}</td></tr>`,
      )
      .join('');
    const mantaRow =
      mantaE2e?.success
        ? `<tr><td>manta</td><td>${mantaE2e.ms.total ?? '—'}</td><td>${pct(mantaE2e.sentenceRecall.ratio)}</td><td>${pct(mantaE2e.bigram.f1)}</td><td>${mantaE2e.charRatio.toFixed(2)}</td></tr>`
        : '';
    e2eHtml = `<h4>端到端对比 <small>基线真实流程（goto→networkidle 尽力等待→立即抽取，无预热/无懒加载回填）；质量相对各自页面</small></h4>
<table><thead><tr><th>引擎</th><th>端到端ms</th><th>句子召回</th><th>bigram F1</th><th>字符比</th></tr></thead><tbody>${mantaRow}${e2eRows}</tbody></table>`;
  }
  return `<div class="case"><h3>${esc(r.case)} <small>profile: ${esc(r.profileName ?? '无(generic)')}${r.profileName ? ' · 参考系=主内容区' : ' · 参考系=整页'}${r.gold.stale ? ' · ⚠ 金样过期' : ''}${r.gold.present ? ' · ✓ 金样' : ''}</small></h3>
<table><thead>${head}</thead><tbody>${rows}</tbody></table>
${e2eHtml}
<p class="muted">一致性（bigram F1 两两）：${matrix}</p></div>`;
}

/** 完整 HTML 报告页 */
export function renderReportHtml(current: HistoryEntry, reports: CaseReport[], history: HistoryEntry[]): string {
  const engineNames = [...new Set(history.flatMap((h) => Object.keys(h.aggregate)))];
  const aggRows = Object.entries(current.aggregate)
    .map(
      ([e, a]) =>
        `<tr><td style="color:${engineColor(e)}"><b>${esc(e)}</b></td><td>${pct(a.successRate)}</td><td>${pct(a.sentenceRecallAvg)}</td><td>${pct(a.bigramF1Avg)}</td><td>${a.goldContentF1Avg >= 0 ? pct(a.goldContentF1Avg) : '—'}</td><td>${Math.round(a.msTotalAvg ?? 0)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>manta-fetcher 抽取效果对比报告</title>
<style>
  body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#111827;line-height:1.5}
  h1{font-size:22px} h2{font-size:17px;margin-top:32px;border-bottom:1px solid #e5e7eb;padding-bottom:6px}
  h3{font-size:14px;margin:14px 0 6px} small{color:#6b7280;font-weight:normal}
  table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}
  th,td{border:1px solid #e5e7eb;padding:5px 9px;text-align:left}
  th{background:#f9fafb}
  .muted{color:#6b7280;font-size:12px}
  .chart{margin:18px 0}
  .legend span{margin-right:16px;font-size:12px}
  .meta{color:#6b7280;font-size:12px}
</style></head><body>
<h1>抽取效果双向对比报告</h1>
<p class="meta">生成于 ${esc(shortTs(current.ts))} · 第 ${history.length} 次运行 · 工件目录 ~/.manta-fetcher/cache/bench/</p>

<h2>本次聚合（跨 case 均值）</h2>
<table><thead><tr><th>引擎</th><th>成功率</th><th>句子召回</th><th>bigram F1</th><th>金样内容 F1</th><th>耗时ms</th></tr></thead><tbody>${aggRows}</tbody></table>
<p class="muted">⭐=使用站点 profile（mainContent/remove 裁剪）；句子召回基于全页可见文本，列表页上无降噪引擎虚高，应结合噪音率与字符比解读。</p>

<h2>分 case 对比</h2>
${reports.map(caseTable).join('')}

<h2>历史趋势（aggregate）</h2>
${lineChart(history, (a) => a?.sentenceRecallAvg, '句子召回率（跨 case 均值）', engineNames)}
${lineChart(history, (a) => a?.bigramF1Avg, '字符 bigram F1（跨 case 均值）', engineNames)}
${lineChart(history, (a) => a?.goldContentF1Avg, '金样内容 F1（有金样 case 均值，-1 视为无）', engineNames)}

<h2>历史运行</h2>
<table><thead><tr><th>#</th><th>时间</th><th>引擎</th><th>句子召回</th><th>bigram F1</th><th>金样 F1</th></tr></thead><tbody>
${(() => {
  let rows = '';
  history.forEach((h, i) => {
    Object.entries(h.aggregate).forEach(([e, a], k) => {
      rows += `<tr><td>${k === 0 ? `#${i + 1}` : ''}</td><td>${k === 0 ? esc(shortTs(h.ts)) : ''}</td><td style="color:${engineColor(e)}">${esc(e)}</td><td>${pct(a.sentenceRecallAvg)}</td><td>${pct(a.bigramF1Avg)}</td><td>${a.goldContentF1Avg >= 0 ? pct(a.goldContentF1Avg) : '—'}</td></tr>`;
    });
  });
  return rows;
})()}
</tbody></table>
</body></html>`;
}

/** 写 HTML 报告：默认追加本次到历史 jsonl（离线重算传 append:false，避免重复点），
 * 渲染含全量历史趋势的 report.html，返回路径 */
export function writeHtmlReport(dir: string, reports: CaseReport[], opts: { append?: boolean } = {}): string {
  const entry = buildHistoryEntry(reports);
  if (opts.append !== false) appendHistory(dir, entry);
  const p = path.join(dir, 'report.html');
  fs.writeFileSync(p, renderReportHtml(entry, reports, [...loadHistory(dir), entry]));
  return p;
}
