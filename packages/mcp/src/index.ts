#!/usr/bin/env node
import { printBanner } from './cli/banner.js';
import { runCli } from './cli.js';
import { serve } from './server.js';

const [, , cmd, ...rest] = process.argv;

// -v / --version：打印版本号后直接退出（stdout 必须干净，不走 runCli）
if (cmd === '-v' || cmd === '--version' || cmd === 'version') {
  const { printVersion } = await import('./cli/version.js');
  printVersion();
  process.exit(0);
}

// 面向人的少数命令先打 banner（见 cli/banner.ts，非 TTY 内部二次把关不输出）：
// help / init / doctor。test / tools 等输出可能被脚本解析、无参 serve 是 stdio MCP
//（stdout 必须干净），均不打。
if (['help', '--help', '-h', 'init', '-i', '--init', 'doctor'].includes(cmd)) {
  printBanner();
}

if (!cmd || cmd === 'serve') {
  await serve();
} else if (cmd === '-i' || cmd === '--init') {
  await runCli('init', rest); // init 的短别名（对齐 joybuddy -i）
} else {
  await runCli(cmd, rest);
}
