// `manta-fetcher --version`：打印版本号。从 package.json 读取（仓库内 dist/ 与装包后的
// node_modules/<pkg>/dist/ 都在包根下一层，两种运行位置均成立）；serve 的版本号也引用这里。
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version?: string };

/** 当前包版本号 */
export const APP_VERSION = pkg.version ?? '0.0.0';

export function printVersion(): void {
  process.stdout.write(`manta-fetcher ${APP_VERSION}\n`);
}
