import fs from 'node:fs';
import path from 'node:path';
import { articlesCacheDir, coreVersion } from '../paths.js';
import type { FetchResult } from './FetchEngine.js';

export interface SaveLayoutOptions {
  /** 文件名 slug（缺省用页面标题，再退到 URL） */
  slug?: string;
  /**
   * 落盘布局（统一规则，落盘根 = dataRoot，git 项目内为 <项目根>/.manta-fetcher，否则 <cwd>/.manta-fetcher）：
   *   <落盘根>/cache/articles/<站点名>/<本地日期 YYYY-MM-DD>/<本地时间 HHmmss>-<slug>.layout.json
   * 序号前缀由调用方通过 slug 传（如组合场景传 "01-标题"），单篇只传 slug。
   */
}

export interface SavedLayout {
  /** JSON 文件路径（相对 cwd） */
  file: string;
}

/** 把任意标题/URL 规整成安全文件名 slug */
export function sanitizeSlug(input: string): string {
  const s = input.replace(/[^a-zA-Z0-9一-龥._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 60) || 'untitled';
}

function slugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = (u.pathname.split('/').filter(Boolean).pop() ?? '') + (u.search || '');
    const s = tail.replace(/[^a-zA-Z0-9一-龥._-]+/g, '-').replace(/^-+|-+$/g, '');
    return s.slice(0, 60) || u.hostname;
  } catch {
    return 'untitled';
  }
}

/** 本地时间 YYYY-MM-DD */
function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时间 HHmmss */
function localTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 文件元信息用本地时间串：YYYY-MM-DD HH:mm:ss */
function localStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${localDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 落盘 IR 的 schema 版本：nodes 结构变化时递增；preview server 对不兼容版本跳过展示。
 * v3 = IR v3：enrichLayout 参数化（scoring.ts）、lazyImgAttrs 可配置（新增 data-lazy 候选） */
export const LAYOUT_SCHEMA_VERSION = 3;

/**
 * 通用落盘（目录固定在用户级，跨项目共享，preview server 扫描同目录）：
 * <落盘根>/cache/articles/<站点>/<本地日期>/<本地HHmmss>-<slug>.layout.json
 * 内容 = 页面元信息（含 schemaVersion/coreVersion，标记产出时的 IR 结构与 core 版本）+ 内容 IR。
 */
export function saveLayout(result: FetchResult, opts: SaveLayoutOptions = {}): SavedLayout {
  const now = new Date();
  const dir = path.resolve(articlesCacheDir, result.site, localDate(now));
  fs.mkdirSync(dir, { recursive: true });
  const slug = opts.slug ?? (result.title || slugFromUrl(result.url));
  const file = path.join(dir, `${localTime(now)}-${sanitizeSlug(slug)}.layout.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        url: result.url,
        site: result.site,
        title: result.title,
        fetchedAt: localStamp(now),
        schemaVersion: LAYOUT_SCHEMA_VERSION,
        coreVersion,
        ...result.layout,
      },
      null,
      2,
    ),
  );
  return { file: path.relative(process.cwd(), file) };
}
