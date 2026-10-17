import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  articlesCacheDir,
  BrowserPool,
  effectiveProfile,
  FetchEngine,
  interactiveLogin,
  openPreviewPage,
  ProfileRegistry,
  registerPreview,
} from '@manta-fetcher/core';
import type { PageLayout, PreviewMeta } from '@manta-fetcher/core';

const USAGE = `manta-fetcher — 场景化网页采集 MCP

用法:
  manta-fetcher serve              启动 MCP server（stdio，默认）
  manta-fetcher login <站点名> <起始URL>
                                   打开有头浏览器手动登录，回车后保存登录态到 auth/<站点名>.storage.json
  manta-fetcher test <URL> [站点名] [--save] [--preview]
                                   抓取一次并把内容 IR 输出到 stdout（调 Profile 时用，不用启动 MCP）；
                                   --save 落盘到用户级采集目录（~/.manta-fetcher/cache/articles）；
                                   --preview 额外启动本地预览 server 渲染布局并自动打开浏览器
  manta-fetcher preview [<URL | layout.json 路径>] [--dir <目录>]
                                   启动本地预览 server 渲染布局并自动打开浏览器；
                                   不带参数：批量加载落盘目录（默认 ~/.manta-fetcher/cache/articles）
                                   下所有布局 JSON，左侧列表可切换，最新的一份默认展示；
                                   传 layout.json 路径则离线加载不重新抓取；传 URL 会先抓取

MCP 客户端配置示例 (.mcp.json):
  { "mcpServers": { "manta-fetcher": { "command": "node", "args": ["<本项目路径>/dist/index.js"] } } }
`;

export async function runCli(cmd: string | undefined, args: string[]): Promise<void> {
  switch (cmd) {
    case undefined:
    case 'serve':
      return; // 由 index.ts 处理 serve
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    case 'login':
      return cmdLogin(args);
    case 'test':
      return cmdTest(args);
    case 'preview':
      return cmdPreview(args);
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

/** 交互式登录：有头浏览器打开页面，用户手动登录后回车保存登录态（实现见 core/auth/login.ts） */
async function cmdLogin(args: string[]): Promise<void> {
  const [site, startUrl] = args;
  if (!site || !startUrl) {
    console.error('用法: manta-fetcher login <站点名> <起始URL>');
    process.exitCode = 1;
    return;
  }
  await interactiveLogin(site, startUrl);
}

/** 调试 Profile：抓一次，内容 IR JSON 输出到 stdout，元信息走 stderr；--save 落盘 / --preview 开视觉预览 */
async function cmdTest(args: string[]): Promise<void> {
  const preview = args.includes('--preview');
  const save = args.includes('--save');
  const rest = args.filter((a) => a !== '--preview' && a !== '--save');
  const [url, profileName] = rest;
  if (!url) {
    console.error('用法: manta-fetcher test <URL> [站点名]');
    process.exitCode = 1;
    return;
  }
  const registry = new ProfileRegistry();
  await registry.reload();
  const profile = profileName ? registry.byName(profileName) : registry.match(url);
  const def = profile?.def ?? null;
  console.error(
    `[manta-fetcher] 站点配置: ${def?.name ?? 'generic（通用管线兜底）'}` +
      (profile ? ` (${profile.filePath})` : ''),
  );

  const pool = new BrowserPool(2);
  const engine = new FetchEngine(pool);
  try {
    const result = await engine.fetch(url, effectiveProfile(def));
    console.error(
      `[manta-fetcher] 标题: ${result.title} · 节点 ${result.layout.nodes.length}` +
        (result.layout.truncated ? '（已截断）' : ''),
    );
    if (save) {
      const { saveLayout } = await import('@manta-fetcher/core');
      const saved = saveLayout(result);
      console.error(`[manta-fetcher] 落盘: ${saved.file}`);
    }
    if (preview) {
      const { registerPreview } = await import('@manta-fetcher/core');
      const previewUrl = await registerPreview(result.layout, {
        title: result.title || result.url,
        url: result.url,
        fetchedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
      console.error(`[manta-fetcher] 预览: ${previewUrl}（server 随本进程存续，Ctrl+C 退出）`);
      // 挂住进程，保持预览 server 存活
      await new Promise(() => {});
    }
    process.stdout.write(JSON.stringify({ ...result.layout }, null, 2) + '\n');
  } finally {
    await pool.close().catch(() => {});
  }
}

/**
 * 视觉预览：启动本地预览 server 渲染布局并自动打开浏览器（实现见 core/layout/previewServer.ts）。
 * 不带参数：批量加载落盘目录 ~/.manta-fetcher/cache/articles（--dir 可改）下所有布局 JSON，
 * 左侧列表可切换；带文件路径：离线加载该 JSON；带 URL：抓取后预览（可选第二参数指定站点名）。
 */
async function cmdPreview(args: string[]): Promise<void> {
  const dirFlagIdx = args.indexOf('--dir');
  const dir = dirFlagIdx >= 0 ? (args.splice(dirFlagIdx, 2)[1] ?? '') : undefined;
  args = args.filter((a) => a !== '--dir');
  const [input, profileName] = args;
  if (!input && dir !== undefined) {
    console.error('用法: manta-fetcher preview [<URL | layout.json 路径>] [--dir <目录>]');
    process.exitCode = 1;
    return;
  }

  if (!input && !dir) {
    // 无参数：落盘目录由预览 server 自行扫描展示（~/.manta-fetcher/cache/articles），直接开页面即可
    const count = countLayoutFiles(articlesCacheDir);
    if (count === 0) {
      console.error(
        `[manta-fetcher] 落盘目录下没有布局 JSON: ${articlesCacheDir}\n` +
          `先用 MCP 的 saveTo 落盘，或 manta-fetcher preview <URL> 抓取一份；也可 preview <layout.json 路径> 或 --dir <目录>`,
      );
      process.exitCode = 1;
      return;
    }
    const url = await openPreviewPage();
    console.error(
      `[manta-fetcher] 落盘 ${count} 份布局: ${url}（server 随本进程存续，Ctrl+C 退出）`,
    );
    // 挂住进程，保持预览 server 存活
    await new Promise(() => {});
  }

  if (!input) {
    // --dir 指定了目录：把该目录下的文件注册成会话条目预览
    return cmdPreviewAll(dir!);
  }

  let meta: PreviewMeta;
  let layout: PageLayout;

  if (fs.existsSync(input) && fs.statSync(input).isFile()) {
    const loaded = loadLayoutFile(input);
    meta = loaded.meta;
    layout = loaded.layout;
  } else {
    const registry = new ProfileRegistry();
    await registry.reload();
    const profile = profileName ? registry.byName(profileName) : registry.match(input);
    const def = profile?.def ?? null;
    console.error(
      `[manta-fetcher] 站点配置: ${def?.name ?? 'generic（通用管线兜底）'}` +
        (profile ? ` (${profile.filePath})` : ''),
    );

    const pool = new BrowserPool(2);
    const engine = new FetchEngine(pool);
    try {
      const result = await engine.fetch(input, effectiveProfile(def));
      console.error(
        `[manta-fetcher] 标题: ${result.title} · 节点 ${result.layout.nodes.length}` +
          (result.layout.truncated ? '（已截断）' : ''),
      );
      meta = {
        title: result.title || result.url,
        url: result.url,
        fetchedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      };
      layout = result.layout;
    } finally {
      await pool.close().catch(() => {});
    }
  }

  const previewUrl = await registerPreview(layout, meta);
  console.error(`[manta-fetcher] 预览: ${previewUrl}（server 随本进程存续，Ctrl+C 退出）`);
  // 挂住进程，保持预览 server 存活
  await new Promise(() => {});
}

/** 加载单个落盘布局 JSON（{ url, site, title, fetchedAt, ...layout } 或纯 IR { ...layout }） */
function loadLayoutFile(file: string): { meta: PreviewMeta; layout: PageLayout } {
  let saved: {
    url?: string;
    title?: string;
    fetchedAt?: string;
    nodes?: unknown;
    viewport?: [number, number];
    docHeight?: number;
    truncated?: boolean;
  };
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`解析 JSON 失败: ${err instanceof Error ? err.message : err}`);
  }
  if (!Array.isArray(saved.nodes)) {
    throw new Error(`不是有效的布局 JSON（缺少 nodes 字段）`);
  }
  return {
    layout: {
      viewport: saved.viewport ?? [0, 0],
      docHeight: saved.docHeight ?? 0,
      truncated: saved.truncated,
      nodes: saved.nodes,
    } as PageLayout,
    meta: {
      title: saved.title || path.basename(file),
      url: saved.url || '',
      fetchedAt: saved.fetchedAt || new Date().toLocaleString('zh-CN', { hour12: false }),
    },
  };
}

/** 递归统计目录下 *.layout.json 数量（目录不存在算 0） */
function countLayoutFiles(dir: string): number {
  try {
    return fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.layout.json')).length;
  } catch {
    return 0;
  }
}

/**
 * --dir 批量预览：递归扫描指定目录下所有 .layout.json 注册成会话条目，左侧列表可切换。
 * （无参数时不走这里：标准落盘目录由预览 server 自行扫描，见 cmdPreview）
 */
async function cmdPreviewAll(dir: string): Promise<void> {
  const absDir = path.resolve(dir);
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(absDir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.layout.json'))
      .map((f) => path.join(absDir, f))
      .sort(
        (a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs, // 最新的排最后、默认展示
      );
  } catch {
    // 目录不存在，走下面的空列表提示
  }
  if (files.length === 0) {
    console.error(
      `[manta-fetcher] 目录下没有可预览的布局 JSON: ${absDir}\n` +
        `先用 MCP 的 saveTo 落盘，或 manta-fetcher test <URL> [站点名] > xxx.json 手动保存；也可指定 --dir <目录>`,
    );
    process.exitCode = 1;
    return;
  }

  let previewUrl = '';
  let failed = 0;
  for (const [i, file] of files.entries()) {
    try {
      const { meta, layout } = loadLayoutFile(file);
      // 只在最后一个（默认展示的那份）打开浏览器，其余静默注册进左侧列表
      previewUrl = await registerPreview(layout, meta, { open: i === files.length - 1 });
      console.error(`[manta-fetcher] 加载: ${meta.title} · 节点 ${layout.nodes.length}`);
    } catch (err) {
      failed++;
      console.error(`[manta-fetcher] 跳过 ${path.relative(absDir, file)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!previewUrl) {
    console.error('[manta-fetcher] 所有文件都解析失败，无法预览');
    process.exitCode = 1;
    return;
  }
  console.error(
    `[manta-fetcher] 预览 ${files.length - failed} 份布局: ${previewUrl}（server 随本进程存续，Ctrl+C 退出）`,
  );
  // 挂住进程，保持预览 server 存活
  await new Promise(() => {});
}
