import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 配置目录相对当前工作目录（在哪个目录启动，就在哪个目录下找 profiles） */
export const projectRoot = process.cwd();
export const profilesDir = path.join(projectRoot, 'profiles');
export const cacheDir = path.join(projectRoot, 'cache');
export const imagesDir = path.join(cacheDir, 'images');

/** 用户级数据目录：登录态、落盘产物（IR JSON、失败截图）都存 ~/.manta-fetcher，跨项目、跨 cwd 共享 */
export const userCacheDir = path.join(os.homedir(), '.manta-fetcher', 'cache');
export const authDir = path.join(os.homedir(), '.manta-fetcher', 'auth');
export const articlesCacheDir = path.join(userCacheDir, 'articles');
export const screenshotsDir = path.join(userCacheDir, 'screenshots');

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
