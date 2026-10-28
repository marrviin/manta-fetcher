import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 配置目录相对当前工作目录（在哪个目录启动，就在哪个目录下找 cache 等） */
export const projectRoot = process.cwd();

/**
 * 落盘产物根目录：从 cwd 向上找 .git，找到则用仓库根下的 <repo>/.manta-fetcher（产物跟随项目），
 * 找不到（不在任何 git 仓库内）则用启动目录下的 <cwd>/.manta-fetcher。
 * 目录结构保持一致：<root>/cache/articles、<root>/cache/screenshots。
 */
function findProjectDataRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.join(dir, '.manta-fetcher');
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(process.cwd(), '.manta-fetcher');
    dir = parent;
  }
}

export const dataRoot = findProjectDataRoot();
/** 落盘产物目录（IR JSON、失败截图），根目录见 dataRoot */
export const userCacheDir = path.join(dataRoot, 'cache');
export const articlesCacheDir = path.join(userCacheDir, 'articles');
export const screenshotsDir = path.join(userCacheDir, 'screenshots');
/** 本地图片库：<dataRoot>/cache/images/<site>（download 模式缺省目录） */
export const imagesDir = path.join(userCacheDir, 'images');

/**
 * 用户自建 profiles：与落盘产物同一根目录（git 项目内 <项目根>/.manta-fetcher/profiles，否则 <cwd>/.manta-fetcher/profiles）。
 * 不随包内置发布；仓库根 profiles/ 只是示例模板，开发调试可用 MANTA_FETCHER_PROFILES_DIR 指过去。
 */
export const profilesDir =
  process.env.MANTA_FETCHER_PROFILES_DIR || path.join(dataRoot, 'profiles');

/** 登录态始终存用户级 ~/.manta-fetcher/auth，跨项目、跨 cwd 共享 */
export const authDir = path.join(os.homedir(), '.manta-fetcher', 'auth');

/** core 包版本（落盘 JSON 记录抓取时的产出版本，便于排查新旧 schema 混杂）；src/dist 两种运行位置都在包根下一层 */
export const coreVersion: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '';
  } catch {
    return '';
  }
})();

export function storageStatePath(site: string): string {
  return path.join(authDir, `${site}.storage.json`);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
