/**
 * bench 采集层：每个 case 一个 Playwright 页面，与 FetchEngine.fetch 相同的生命周期
 * （goto → extraWait → actions → prepare → warmPageForLayout），先 dump 统一快照
 * （懒加载回填规范化，三个引擎看到同一份输入），再在同一页上跑 manta 采集。
 * 快照/输出缓存于 ~/.manta-fetcher/cache/bench/<case>/。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Page } from 'playwright';
import {
  BrowserPool,
  GOTO_WAIT_UNTILS,
  ProfileRegistry,
  collectLayoutFn,
  effectiveProfile,
  enrichLayout,
  layoutToMarkdown,
  partialScoringParams,
  runActions,
  runExtraWait,
  warmPageForLayout,
  type ExtractArgs,
  type PageLayout,
} from '@manta-fetcher/core';
import type { BenchCase } from './cases.mts';
import type { DomStats } from './metrics.mts';

export const BENCH_DIR = path.join(os.homedir(), '.manta-fetcher', 'cache', 'bench');
export const caseDir = (name: string): string => path.join(BENCH_DIR, name);

export interface MantaRun {
  md: string;
  meta: { success: boolean; error?: string; ms: { total: number; warm: number; collect: number; md: number }; profileAware: boolean };
  layout: PageLayout;
  title: string;
  url: string;
}

/** 懒加载回填 + 快照/参考文本/结构计数一次性提取（浏览器侧）；lazyFill=false 保留原始懒加载状态（端到端层用） */
async function dumpSnapshot(
  page: Page,
  mainContent?: string,
  lazyFill = true,
): Promise<{ html: string; text: string; coreText: string; stats: DomStats }> {
  return page.evaluate(({ mc, lazyFill }) => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (typeof g.__name !== 'function') g.__name = (fn: unknown) => fn;
    // 快照规范化：src 为空/data: 的 img 回填懒加载属性（与引擎内置表一致），基线不再被懒加载惩罚
    // （算法层开启；端到端层关闭——漏掉懒加载正是被测行为）
    if (lazyFill) {
      for (const img of Array.from(document.images)) {
        const src = img.getAttribute('src') || '';
        if (src && !src.startsWith('data:')) continue;
        for (const a of ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-lazy']) {
          const v = img.getAttribute(a);
          if (v) {
            img.setAttribute('src', v);
            break;
          }
        }
      }
    }
    const visible = (e: Element): boolean => {
      const cs = getComputedStyle(e);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const imgs = new Set<string>();
    for (const img of Array.from(document.images)) {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) continue;
      try {
        imgs.add(new URL(src, document.baseURI).href);
      } catch {
        /* skip */
      }
    }
    // 主内容区参考文本（独立于任何引擎的评分，仅按 profile 选择器取 DOM 文本）
    let coreText = '';
    if (mc) {
      try {
        coreText = document.querySelector(mc)?.innerText || '';
      } catch {
        coreText = '';
      }
    }
    return {
      html: document.documentElement.outerHTML,
      text: document.body?.innerText || '',
      coreText,
      stats: {
        headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(visible).length,
        images: imgs.size,
        links: Array.from(document.querySelectorAll('a[href]')).filter(visible).length,
        tables: document.querySelectorAll('table').length,
        textChars: (document.body?.innerText || '').replace(/\s+/g, '').length,
      },
    };
  }, { mc: mainContent, lazyFill });
}

export interface CaptureResult {
  manta: MantaRun;
  domStats: DomStats;
  pageText: string;
  /** mainContent 的 DOM 参考文本（有 profile 时非空；无 profile 用 pageText 兜底） */
  coreText: string;
}

export interface BaselineE2ESnap {
  html: string;
  text: string;
  stats: DomStats;
  ms: { total: number };
}

/** 基线端到端采集：基线自己的真实流程——goto(load) → networkidle 尽力等待（5s 封顶）→
 * 立即 dump（无预热、无懒加载回填），漏掉懒加载正是端到端层要测的真实行为 */
export async function captureBaselineE2E(url: string, pool: BrowserPool): Promise<BaselineE2ESnap> {
  const context = await pool.contextFor('bench-e2e', {});
  await pool.acquire();
  const page = await context.newPage();
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const snap = await dumpSnapshot(page, undefined, false);
    return { html: snap.html, text: snap.text, stats: snap.stats, ms: { total: Date.now() - t0 } };
  } finally {
    await page.close().catch(() => {});
    pool.release();
  }
}

/** 复用缓存快照跑 manta 之外的离线引擎由 engines.mts 完成；capture 只负责页面侧 */
export async function captureCase(
  c: BenchCase,
  registry: ProfileRegistry,
  pool: BrowserPool,
): Promise<CaptureResult> {
  const dir = caseDir(c.name);
  fs.mkdirSync(path.join(dir, 'engines'), { recursive: true });
  const def = c.profileName ? registry.byName(c.profileName)?.def ?? null : null;
  const eff = effectiveProfile(def);
  // case 级采集覆盖（generic 用例没有 profile 可调，直接在 case 上声明）
  if (c.waitUntil) eff.waitUntil = c.waitUntil;
  if (c.timeoutMs) eff.timeoutMs = c.timeoutMs;

  const context = await pool.contextFor(eff.name, {
    userAgent: eff.userAgent,
    viewport: eff.viewport,
    locale: eff.locale,
    cdpEndpoint: eff.cdpEndpoint,
  });
  await pool.acquire();
  const page = await context.newPage();
  const t0 = Date.now();
  try {
    const gotoWait = (GOTO_WAIT_UNTILS as readonly string[]).includes(eff.waitUntil)
      ? (eff.waitUntil as 'load')
      : 'domcontentloaded';
    await page.goto(c.url, { waitUntil: gotoWait, timeout: eff.timeoutMs });
    await runExtraWait(page, eff.waitUntil, eff.timeoutMs);
    await runActions(page, eff.actions);
    await eff.prepare?.(page, { url: c.url });

    const warmT0 = Date.now();
    await warmPageForLayout(page, 8000, eff.mainContent);
    const warmMs = Date.now() - warmT0;

    const snap = await dumpSnapshot(page, eff.mainContent);
    fs.writeFileSync(path.join(dir, 'snapshot.html'), snap.html);
    fs.writeFileSync(path.join(dir, 'pageText.txt'), snap.text);
    if (snap.coreText) fs.writeFileSync(path.join(dir, 'coreText.txt'), snap.coreText);
    fs.writeFileSync(path.join(dir, 'dom-stats.json'), JSON.stringify(snap.stats, null, 2));

    // manta：与 FetchEngine.fetch 相同的参数构造（eff.layout 由 profile 决定）
    const args: ExtractArgs = {
      mainContent: eff.mainContent,
      remove: eff.remove,
      titleSelector: eff.titleSelector,
      minSize: eff.layout?.minSize,
      maxNodes: eff.layout?.maxNodes,
      textMax: eff.layout?.textMax,
      viewportMargin: eff.layout?.viewportMargin == null ? undefined : eff.layout.viewportMargin,
    };
    const collectT0 = Date.now();
    const pass = await page.evaluate(collectLayoutFn, args);
    const extracted = enrichLayout(pass, {
      params: partialScoringParams(eff.layout),
      pageType: eff.layout?.pageType,
    });
    const collectMs = Date.now() - collectT0;

    const mdT0 = Date.now();
    const md = layoutToMarkdown(extracted.layout, { pageUrl: extracted.url });
    const mdMs = Date.now() - mdT0;

    const manta: MantaRun = {
      md,
      meta: { success: true, ms: { total: Date.now() - t0, warm: warmMs, collect: collectMs, md: mdMs }, profileAware: !!eff.mainContent },
      layout: extracted.layout,
      title: extracted.title,
      url: extracted.url,
    };
    return { manta, domStats: snap.stats, pageText: snap.text, coreText: snap.coreText };
  } finally {
    await page.close().catch(() => {});
    pool.release();
  }
}
