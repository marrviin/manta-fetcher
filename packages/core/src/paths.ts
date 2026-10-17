import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 所有运行时目录都相对当前工作目录（在哪个目录启动，就在哪个目录下找 profiles/auth/cache） */
export const projectRoot = process.cwd();
export const profilesDir = path.join(projectRoot, 'profiles');
export const authDir = path.join(projectRoot, 'auth');
export const cacheDir = path.join(projectRoot, 'cache');
export const imagesDir = path.join(cacheDir, 'images');
export const screenshotsDir = path.join(cacheDir, 'screenshots');

/** 用户级数据目录：落盘布局 JSON 存 ~/.manta-fetcher，跨项目、跨 cwd 共享 */
export const userCacheDir = path.join(os.homedir(), '.manta-fetcher', 'cache');
export const articlesCacheDir = path.join(userCacheDir, 'articles');

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
