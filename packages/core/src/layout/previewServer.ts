/**
 * 本地布局预览 server：静态托管 packages/preview 构建产物（Vite React 前端）+ /api 数据接口。
 * MCP preview 时把 PageLayout 注册进会话 server，前端从 /api/* 拉数据渲染；
 * 左侧列表 = 会话注册条目 + 本地落盘的全部 boxtree（saveLayout 产物 *.layout.json，每次请求现扫）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PageLayout } from './boxTree.js';
import { layoutToMarkdown } from './toMarkdown.js';
import { sanitizeSlug } from '../engine/save.js';
import { articlesCacheDir } from '../paths.js';

export interface PreviewMeta {
  title: string;
  url: string;
  fetchedAt: string;
}

interface PreviewEntry extends PreviewMeta {
  id: string;
  layout: PageLayout;
  /** IR → Markdown 投影（layoutToMarkdown），模板左侧可切换布局/Markdown 视图 */
  markdown: string;
}

const entries = new Map<string, PreviewEntry>();
let server: http.Server | null = null;
let listening: Promise<number> | null = null;

/** 落盘扫描根目录（与 saveLayout 缺省目录一致，dataRoot/cache/articles，见 paths.ts） */
const SAVE_ROOT = articlesCacheDir;
const SAVED_PREFIX = 'saved:';

/** 落盘 boxtree 摘要（前端左侧卡片列表用，不含 nodes 本体） */
interface SavedSummary {
  id: string;
  title: string;
  url: string;
  site: string;
  fetchedAt: string;
  nodes: number;
  viewport: [number, number];
  docHeight: number;
  /** 相对 SAVE_ROOT 的 JSON 文件路径（卡片 tooltip 展示） */
  file: string;
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 递归扫描落盘目录下的 *.layout.json（目录不存在/坏文件跳过）；按路径序 = 站点/日期/时间 */
function listSaved(): SavedSummary[] {
  const root = SAVE_ROOT;
  const out: SavedSummary[] = [];
  const walk = (dir: string): void => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        walk(p);
      } else if (it.name.endsWith('.layout.json')) {
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          // 旧 schema（nodes 缺 role 字段）无法投影 markdown/结构视图，跳过不进列表
          if (!Array.isArray(j.nodes) || !j.nodes.length || j.nodes[0].role === undefined) continue;
          out.push({
            id: SAVED_PREFIX + path.relative(root, p),
            title: typeof j.title === 'string' && j.title ? j.title : it.name.replace(/\.layout\.json$/, ''),
            url: typeof j.url === 'string' ? j.url : '',
            site: typeof j.site === 'string' ? j.site : siteOf(j.url ?? ''),
            fetchedAt: typeof j.fetchedAt === 'string' ? j.fetchedAt : '',
            nodes: j.nodes.length,
            viewport: Array.isArray(j.viewport) ? j.viewport : [0, 0],
            docHeight: Number(j.docHeight) || 0,
            file: path.relative(root, p),
          });
        } catch {
          // 坏文件不进列表
        }
      }
    }
  };
  walk(root);
  return out;
}

/** 从磁盘读一份落盘 boxtree 并投影 Markdown；路径越界/坏文件返回 null */
function loadSaved(relPath: string): PreviewEntry | null {
  const root = SAVE_ROOT;
  const file = path.resolve(root, relPath);
  if (!file.startsWith(root + path.sep) || !file.endsWith('.layout.json')) return null;
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(j.nodes)) return null;
  const layout: PageLayout = {
    viewport: Array.isArray(j.viewport) ? j.viewport : [0, 0],
    docHeight: Number(j.docHeight) || 0,
    truncated: j.truncated === true ? true : undefined,
    nodes: j.nodes,
  };
  const id = SAVED_PREFIX + path.relative(root, file);
  return {
    id,
    title: typeof j.title === 'string' && j.title ? j.title : path.basename(file, '.layout.json'),
    url: typeof j.url === 'string' ? j.url : '',
    fetchedAt: typeof j.fetchedAt === 'string' ? j.fetchedAt : '',
    layout,
    markdown: layoutToMarkdown(layout, { pageUrl: j.url }),
  };
}

/** 前端构建产物的 MIME 表（覆盖 vite build 输出） */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/**
 * 预览前端构建产物目录（packages/preview/dist）。
 * core 的 src（packages/core/src/layout/）与 dist（packages/core/dist/layout/）都向上 3 级到 packages/，相对路径一致。
 * 未构建时返回 ''（请求落到占位提示页）。
 */
function previewAppDir(): string {
  const dir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../preview/dist');
  return fs.existsSync(path.join(dir, 'index.html')) ? dir : '';
}

/** 未构建前端时的占位提示页 */
const APP_NOT_BUILT_HTML =
  '<!doctype html><html lang="zh"><meta charset="utf-8"><title>布局预览</title>' +
  '<body style="font-family:system-ui,-apple-system,sans-serif;padding:48px;color:#6e6e73;line-height:2">' +
  '预览前端（packages/preview）尚未构建。<br>' +
  '构建：<code>pnpm --filter @manta-fetcher/preview build</code><br>' +
  '前端热更开发：<code>pnpm --filter @manta-fetcher/preview dev</code>（/api 会代理到本 server，先用 <code>MANTA_PREVIEW_PORT</code> 固定端口启动）</body>';

/** 会话内单例 server；端口随机分配（MANTA_PREVIEW_PORT 可固定，供 Vite dev 代理），进程退出即回收 */
function ensureServer(): Promise<number> {
  if (listening) return listening;
  const appDir = previewAppDir();
  listening = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        // —— 前端静态资源（/api 之外；SPA 回退到 index.html，未构建时给占位提示） ——
        if (!u.pathname.startsWith('/api/')) {
          if (appDir) {
            const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
            const file = path.resolve(appDir, rel);
            if (
              file.startsWith(appDir + path.sep) &&
              fs.existsSync(file) &&
              fs.statSync(file).isFile()
            ) {
              res.writeHead(200, {
                'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
                // 预览是开发调试用页面，禁缓存避免前端改动后浏览器仍显示旧版
                'cache-control': 'no-store',
              });
              res.end(fs.readFileSync(file));
              return;
            }
            // SPA 回退：非文件路径一律回 index.html
            res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
            res.end(fs.readFileSync(path.join(appDir, 'index.html')));
            return;
          }
          if (u.pathname === '/' || u.pathname === '/index.html') {
            res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
            res.end(APP_NOT_BUILT_HTML);
            return;
          }
        }
        if (u.pathname === '/api/layouts') {
          // 落盘条目在前、会话条目在后：前端缺省展示最后一项 = 最新注册的会话布局
          const saved = listSaved().map((s) => ({ ...s, source: 'saved' as const }));
          const session = [...entries.values()].map((e) => ({
            id: e.id,
            title: e.title,
            url: e.url,
            site: siteOf(e.url),
            fetchedAt: e.fetchedAt,
            nodes: e.layout.nodes.length,
            viewport: e.layout.viewport,
            docHeight: e.layout.docHeight,
            source: 'session' as const,
          }));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify([...saved, ...session]));
          return;
        }
        if (u.pathname.startsWith('/api/layout/')) {
          const id = decodeURIComponent(u.pathname.slice('/api/layout/'.length));
          // 会话条目优先；saved: 前缀按相对路径从磁盘现读（落盘文件是只增的，无需缓存）
          const e =
            entries.get(id) ??
            (id.startsWith(SAVED_PREFIX) ? loadSaved(id.slice(SAVED_PREFIX.length)) : undefined);
          if (!e) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: `未知预览 id: ${id}` }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ id: e.id, title: e.title, url: e.url, fetchedAt: e.fetchedAt, layout: e.layout, markdown: e.markdown }));
          return;
        }
        res.writeHead(404).end();
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
    server.on('error', (err) => {
      listening = null;
      reject(err);
    });
    server.listen(Number(process.env.MANTA_PREVIEW_PORT) || 0, '127.0.0.1', () => {
      const addr = server!.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  return listening;
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${url}"`, { timeout: 5000 }, () => {}); // 打开失败不影响主流程
}

/**
 * 确保预览 server 已启动、打开预览页（左侧已含落盘目录的全部 boxtree），返回页面 URL。
 * 落盘目录由 server 每次请求现扫，无需预先注册。
 */
export async function openPreviewPage(): Promise<string> {
  const port = await ensureServer();
  const url = `http://127.0.0.1:${port}/`;
  openInBrowser(url);
  return url;
}

/**
 * 注册一份布局并返回预览 URL。
 * 默认自动打开浏览器；批量注册时传 { open: false } 只注册不打开（预览页左侧可切换）。
 * 同会话重复调用会累积到左侧列表，最新的排在最后、默认展示。
 */
export async function registerPreview(
  layout: PageLayout,
  meta: PreviewMeta,
  opts: { open?: boolean } = {},
): Promise<string> {
  const port = await ensureServer();
  const id = `${sanitizeSlug(meta.title).slice(0, 40) || 'layout'}-${Date.now().toString(36)}`;
  entries.set(id, { id, ...meta, layout, markdown: layoutToMarkdown(layout, { pageUrl: meta.url }) });
  const url = `http://127.0.0.1:${port}/?id=${encodeURIComponent(id)}`;
  if (opts.open !== false) openInBrowser(url);
  return url;
}
