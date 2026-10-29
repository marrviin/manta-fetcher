// manta-fetcher CLI banner：logo + 版本号，由 index.ts 在面向人的子命令（help / init / doctor）前调用。
//
// 两层把关（同 joybuddy banner）：
//   1. 调用侧：无参 serve（stdio MCP，stdout 必须干净）、-v、test 等输出可被脚本解析的命令不打；
//   2. 本函数：stdout 非 TTY（脚本 / CI 管道）同样不打印，保持输出可解析。

import { APP_VERSION } from './version.js';

/** figlet Larry 3D 字体（与 joybuddy logo 同款字体）的 "MANTA"，行尾空白已裁剪。 */
const LOGO = [
  '         ______  __  __  ______  ______',
  " /'\\_/`\\/\\  _  \\/\\ \\/\\ \\/\\__  _\\/\\  _  \\",
  '/\\      \\ \\ \\L\\ \\ \\ `\\\\ \\/_/\\ \\/\\ \\ \\L\\ \\',
  '\\ \\ \\__\\ \\ \\  __ \\ \\ , ` \\ \\ \\ \\ \\ \\  __ \\',
  ' \\ \\ \\_/\\ \\ \\ \\/\\ \\ \\ \\`\\ \\ \\ \\ \\ \\ \\ \\/\\ \\',
  '  \\ \\_\\\\ \\_\\ \\_\\ \\_\\ \\_\\ \\_\\ \\ \\_\\ \\ \\_\\ \\_\\',
  '   \\/_/ \\/_/\\/_/\\/_/\\/_/\\/_/  \\/_/  \\/_/\\/_/',
].join('\n');

// ANSI 颜色（仅 TTY 下输出，且遵循 NO_COLOR 约定；零依赖不引色库）
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';
const SOLID_CYAN = '\u001b[1;36m';

// 渐变端点（RGB）：青 → 紫。仅 COLORTERM 标记 truecolor 的终端走渐变
const GRADIENT_START = [34, 211, 238] as const; // #22d3ee
const GRADIENT_END = [167, 139, 250] as const; // #a78bfa

function gradientAt(t: number): string {
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * t);
  const [r1, g1, b1] = GRADIENT_START;
  const [r2, g2, b2] = GRADIENT_END;
  return `\u001b[38;2;${mix(r1, r2)};${mix(g1, g2)};${mix(b1, b2)}m`;
}

// COLORTERM 是标准信号；常见终端即使不设 COLORTERM 也支持 24-bit 色，按 TERM_PROGRAM 兜底补判
const SUPPORTS_TRUECOLOR =
  /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? '') ||
  ['iTerm.app', 'vscode', 'WezTerm', 'ghostty'].includes(process.env.TERM_PROGRAM ?? '');

/** 打印 CLI banner（渐变 logo + 暗色版本号）。仅 stdout 为 TTY 且未设 NO_COLOR 时输出。 */
export function printBanner(): void {
  if (!process.stdout.isTTY) return;
  const noColor = Boolean(process.env.NO_COLOR);
  const gradient = !noColor && SUPPORTS_TRUECOLOR;
  const plainColor = noColor ? '' : SOLID_CYAN;
  const dim = noColor ? '' : DIM;
  const reset = noColor ? '' : RESET;

  const lines = LOGO.split('\n');
  const width = Math.max(...lines.map((l) => l.length));
  const rendered = lines.map((line) => {
    if (!line) return line;
    if (!gradient) return `${plainColor}${line}${reset}`;
    let out = '\u001b[1m';
    let lastStep = -1;
    for (let i = 0; i < line.length; i++) {
      // 量化为 16 档，同档共用一个色码，减少转义序列数量
      const step = width > 1 ? Math.round((i / (width - 1)) * 16) : 0;
      if (step !== lastStep) {
        out += gradientAt(step / 16);
        lastStep = step;
      }
      out += line[i];
    }
    return out + reset;
  });

  process.stdout.write(rendered.join('\n'));
  process.stdout.write(`\n  ${dim}v${APP_VERSION}${reset}\n\n`);
}
