/**
 * bench 基线引擎适配器：离线解析同一份 snapshot.html。
 * raw-turndown：整页直转（无降噪）；readability-turndown：@mozilla/readability 提取主内容后转 md；
 * trafilatura：Python 基线（packages/bench/.venv，见 scripts/trafilatura-engine.py）。
 * 引擎失败记 success:false，不中断整个基准。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { Rule } from 'turndown';

export interface EngineMeta {
  success: boolean;
  error?: string;
  ms: { total: number };
  profileAware: boolean;
}

export interface EngineOutput {
  md: string;
  meta: EngineMeta;
}

export type OfflineEngine = (snapshotHtml: string, pageUrl: string) => EngineOutput;

function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  // 核心 turndown 不渲染表格：自写 rule（th/td 行拼接 + 分隔行），避免引入未维护的 gfm 插件
  const tableRule: Rule = {
    filter: ['table'],
    replacement: (_content, node) => {
      const table = node as unknown as Element;
      const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th,td'))
          .map((c) => (c.textContent || '').trim().replace(/\|/g, '\\|'))
          .join(' | '),
      );
      if (!rows.length) return '';
      const cols = rows[0].split(' | ').length;
      const [head, ...rest] = rows;
      return [
        `| ${head} |`,
        `| ${Array.from({ length: cols }).fill('---').join(' | ')} |`,
        ...rest.map((r) => `| ${r} |`),
      ].join('\n');
    },
  };
  td.addRule('bench-tables', tableRule);
  return td;
}

const turndown = makeTurndown();

/** 整页直转：同页 dump 的 DOM 原样转 markdown，不做任何降噪/裁剪 */
const rawTurndown: OfflineEngine = (snapshotHtml, pageUrl) => {
  const t0 = Date.now();
  try {
    // 注入 <base> 保证相对链接/图片在 jsdom/turndown 侧可解析
    const md = turndown.turndown(withBase(snapshotHtml, pageUrl));
    return { md, meta: { success: true, ms: { total: Date.now() - t0 }, profileAware: false } };
  } catch (err) {
    return {
      md: '',
      meta: { success: false, error: err instanceof Error ? err.message : String(err), ms: { total: Date.now() - t0 }, profileAware: false },
    };
  }
};

/** Readability 主内容提取 → turndown；parse 返回 null/抛错都记失败（合法基线结果） */
const readabilityTurndown: OfflineEngine = (snapshotHtml, pageUrl) => {
  const t0 = Date.now();
  try {
    const dom = new JSDOM(withBase(snapshotHtml, pageUrl), { url: pageUrl });
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.content) {
      return { md: '', meta: { success: false, error: 'Readability.parse() 返回空（未识别出主内容）', ms: { total: Date.now() - t0 }, profileAware: false } };
    }
    const md = turndown.turndown(article.content);
    return { md, meta: { success: true, ms: { total: Date.now() - t0 }, profileAware: false } };
  } catch (err) {
    return {
      md: '',
      meta: { success: false, error: err instanceof Error ? err.message : String(err), ms: { total: Date.now() - t0 }, profileAware: false },
    };
  }
};

/** 给 html 注入 <base href>，让快照里的相对 URL 在离线解析时与线上等价 */
function withBase(html: string, pageUrl: string): string {
  if (/<base\s/i.test(html)) return html;
  return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n<base href="${pageUrl}">`);
}

/**
 * trafilatura（Python 生态标杆基线）：HTML 经 stdin 传给独立进程，markdown 回 stdout。
 * venv 缺失时记失败并提示 setup（不中断基准——引擎失败是合法基线结果）。
 */
const trafilaturaEngine: OfflineEngine = (snapshotHtml, pageUrl) => {
  const t0 = Date.now();
  const wrapper = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'trafilatura');
  if (!fs.existsSync(wrapper)) {
    return { md: '', meta: { success: false, error: 'trafilatura wrapper 缺失', ms: { total: Date.now() - t0 }, profileAware: false } };
  }
  const r = spawnSync(wrapper, [pageUrl], {
    input: snapshotHtml,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    return { md: '', meta: { success: false, error: `spawn 失败: ${r.error.message}`, ms: { total: Date.now() - t0 }, profileAware: false } };
  }
  if (r.status !== 0 || !r.stdout?.trim()) {
    const err = (r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`;
    return { md: '', meta: { success: false, error: err.slice(0, 200), ms: { total: Date.now() - t0 }, profileAware: false } };
  }
  return { md: r.stdout, meta: { success: true, ms: { total: Date.now() - t0 }, profileAware: false } };
};

export const OFFLINE_ENGINES: Record<string, OfflineEngine> = {
  'raw-turndown': rawTurndown,
  'readability-turndown': readabilityTurndown,
  trafilatura: trafilaturaEngine,
};

export const ENGINE_NAMES = ['manta', ...Object.keys(OFFLINE_ENGINES)] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];
