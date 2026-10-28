import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'manta-fetcher';

type InstallResult = 'added' | 'updated' | 'exists';

export interface McpEntry {
  command: string;
  args: string[];
  [key: string]: unknown;
}

/** 本文件编译后在 <pkg>/dist/cli/init.js（源码运行时在 <pkg>/src/cli/init.ts），两级向上都是包根 */
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** manta-fetcher 的启动命令：直接指向 dist/index.js + 当前 node 二进制，不依赖 PATH 与全局安装 */
export function mcpCommand(): McpEntry & { built: boolean } {
  const indexJs = path.join(pkgDir, 'dist', 'index.js');
  return { command: process.execPath, args: [indexJs], built: existsSync(indexJs) };
}

/** 是否在 PATH 上 */
function which(name: string): boolean {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir && existsSync(path.join(dir, name)));
}

const detectClaude = (home: string) =>
  existsSync(path.join(home, '.claude.json')) ||
  existsSync(path.join(home, '.claude')) ||
  which('claude');

const detectCursor = (home: string) => existsSync(path.join(home, '.cursor')) || which('cursor');

/** 已记录条目是否与标准启动命令一致（只比 command/args，忽略 type/env 等附加字段） */
function entryMatches(raw: unknown, standard: McpEntry): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const entry = raw as Record<string, unknown>;
  const args = Array.isArray(entry.args)
    ? (entry.args as unknown[]).filter((a): a is string => typeof a === 'string')
    : null;
  return (
    entry.command === standard.command &&
    args !== null &&
    JSON.stringify(args) === JSON.stringify(standard.args)
  );
}

/** 把配置写进 JSON 配置文件的 mcpServers 字段（保留文件里其余内容；已存在但指向不同时覆盖） */
function updateJsonMcp(
  configPath: string,
  server: McpEntry,
): InstallResult {
  let json: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    if (raw.trim()) {
      try {
        json = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`解析 ${configPath} 失败: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  const mcpServers = (json.mcpServers ?? {}) as Record<string, unknown>;
  if (mcpServers[SERVER_NAME]) {
    if (entryMatches(mcpServers[SERVER_NAME], server)) return 'exists';
    mcpServers[SERVER_NAME] = server;
    json.mcpServers = mcpServers;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n');
    return 'updated';
  }
  mcpServers[SERVER_NAME] = server;
  json.mcpServers = mcpServers;
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n');
  return 'added';
}

/** 删除 [mcp_servers.manta-fetcher] 段（到下一个 TOML 段头为止） */
function stripTomlSection(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`).test(l),
  );
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  lines.splice(start, end - start);
  return lines.join('\n');
}

/** 往 Codex 的 config.toml 追加 mcp_servers 段（只追加，不重写已有内容；已有但指向不同时覆盖） */
function updateTomlMcp(configPath: string, cmd: McpEntry): InstallResult {
  let text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const hasSection = new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`, 'm').test(text);
  if (hasSection) {
    if (tomlEntryMatches(text, cmd)) return 'exists';
    text = stripTomlSection(text);
    if (text && !text.endsWith('\n')) text += '\n';
    text += `\n[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(cmd.command)}\nargs = ${JSON.stringify(cmd.args)}\n`;
    writeFileSync(configPath, text);
    return 'updated';
  }
  if (text && !text.endsWith('\n')) text += '\n';
  text += `\n[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(cmd.command)}\nargs = ${JSON.stringify(cmd.args)}\n`;
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, text);
  return 'added';
}

/** 读回 config.toml 里 [mcp_servers.manta-fetcher] 段的 command/args，判断是否与标准命令一致 */
function tomlEntryMatches(text: string, cmd: McpEntry): boolean {
  const lines = text.split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`).test(l),
  );
  if (start === -1) return false;
  let command = '';
  let args: string[] | null = null;
  for (let i = start + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
    const cmdMatch = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(lines[i]);
    if (cmdMatch) {
      try {
        command = JSON.parse(`"${cmdMatch[1]}"`) as string;
      } catch {
        command = cmdMatch[1];
      }
    }
    const argsMatch = /^\s*args\s*=\s*(\[[^\]]*\])\s*$/.exec(lines[i]);
    if (argsMatch) {
      try {
        args = (JSON.parse(argsMatch[1]) as unknown[]).filter(
          (a): a is string => typeof a === 'string',
        );
      } catch {
        // args 解析失败按不一致处理，走覆盖
        args = null;
      }
    }
  }
  return command === cmd.command && args !== null && JSON.stringify(args) === JSON.stringify(cmd.args);
}

interface AgentSpec {
  name: string;
  configPath: string;
  detect: () => boolean;
  install: () => InstallResult;
}

/** 各 AI 客户端的 MCP 安装位置与写法（同仓库 .mcp.json 示例保持一致的启动命令） */
function buildAgents(home: string, cmd: McpEntry): AgentSpec[] {
  const jsonCmd = { type: 'stdio', command: cmd.command, args: cmd.args };
  return [
    {
      name: 'Claude Code',
      configPath: path.join(home, '.claude.json'),
      detect: () => detectClaude(home),
      install: () => updateJsonMcp(path.join(home, '.claude.json'), jsonCmd),
    },
    {
      name: 'Cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      detect: () => detectCursor(home),
      install: () => updateJsonMcp(path.join(home, '.cursor', 'mcp.json'), cmd),
    },
    {
      name: 'Gemini CLI',
      // 只认 PATH 上的可执行文件：~/.gemini 这类残留目录不代表还在用
      detect: () => which('gemini'),
      configPath: path.join(home, '.gemini', 'settings.json'),
      install: () => updateJsonMcp(path.join(home, '.gemini', 'settings.json'), cmd),
    },
    {
      name: 'Codex',
      detect: () => which('codex'),
      configPath: path.join(home, '.codex', 'config.toml'),
      install: () => updateTomlMcp(path.join(home, '.codex', 'config.toml'), cmd),
    },
    {
      name: 'JoyCode',
      detect: () => existsSync(path.join(home, '.joycode')) || which('joycode'),
      configPath: path.join(home, '.joycode', 'joycode-mcp.json'),
      install: () => updateJsonMcp(path.join(home, '.joycode', 'joycode-mcp.json'), jsonCmd),
    },
  ];
}

// ---------- Skill 安装 ----------

/** 本仓库的 skill 源目录 packages/skills（从模块位置向上找，兼容 dist / tsx 源码两种运行方式） */
function findSkillsRoot(): string | null {
  let dir = pkgDir;
  for (;;) {
    const cand = path.join(dir, 'packages', 'skills');
    if (existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface SkillTargetSpec {
  name: string;
  dir: string;
  detect: () => boolean;
}

/** skill 安装位置（用户级，跨项目可用） */
function buildSkillTargets(home: string): SkillTargetSpec[] {
  return [
    {
      name: 'Claude Code',
      dir: path.join(home, '.claude', 'skills'),
      detect: () => detectClaude(home),
    },
    {
      name: 'Cursor',
      dir: path.join(home, '.cursor', 'skills'),
      detect: () => detectCursor(home),
    },
  ];
}

/** 递归比较两个目录内容是否一致（用于跳过已是最新的 skill） */
function dirsEqual(a: string, b: string): boolean {
  let bEntries: string[];
  try {
    bEntries = readdirSync(b);
  } catch {
    return false;
  }
  const aEntries = readdirSync(a);
  if (aEntries.length !== bEntries.length) return false;
  for (const name of aEntries) {
    if (!bEntries.includes(name)) return false;
    const pa = path.join(a, name);
    const pb = path.join(b, name);
    if (existsSync(pa) && existsSync(pb)) {
      if (!statIsDir(pa) && !statIsDir(pb)) {
        if (readFileSync(pa, 'utf8') !== readFileSync(pb, 'utf8')) return false;
      } else if (statIsDir(pa) !== statIsDir(pb)) {
        return false;
      } else if (!dirsEqual(pa, pb)) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

function statIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------- init 主流程 ----------

/**
 * manta-fetcher init：把 MCP server 写进已安装 AI 客户端的配置，并把本仓库
 * packages/skills 下的采集 Skill 复制到客户端的 skill 目录（用户级）。
 * 支持 --no-mcp / --no-skill 跳过其中一部分。
 */
export async function runInit(args: string[]): Promise<void> {
  const noMcp = args.includes('--no-mcp');
  const noSkill = args.includes('--no-skill');
  const home = homedir();
  const rel = (p: string) => p.replace(home, '~');

  console.error('[manta-fetcher] init：安装 MCP 与 Skill 到本机 AI 客户端\n');

  let mcpInstalled = 0;
  let mcpSkipped = 0;
  if (!noMcp) {
    const cmd = mcpCommand();
    if (!cmd.built) {
      console.error(
        `[manta-fetcher] 警告: ${cmd.args[0]} 还不存在，安装后先在仓库根目录执行 pnpm build\n`,
      );
    }
    console.error('MCP:');
    for (const agent of buildAgents(home, cmd)) {
      if (!agent.detect()) {
        console.error(`  - ${agent.name}（未检测到，跳过）`);
        continue;
      }
      try {
        const result = agent.install();
        if (result === 'added') {
          mcpInstalled++;
          console.error(`  ✓ ${agent.name}: 已写入 ${rel(agent.configPath)}`);
        } else if (result === 'updated') {
          mcpInstalled++;
          console.error(`  ✓ ${agent.name}: 已更新 ${rel(agent.configPath)}（原配置指向不同）`);
        } else {
          mcpSkipped++;
          console.error(`  = ${agent.name}: 已有 manta-fetcher 配置，跳过`);
        }
      } catch (e) {
        console.error(`  ✗ ${agent.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    console.error('');
  }

  let skillInstalled = 0;
  if (!noSkill) {
    const skillsRoot = findSkillsRoot();
    if (!skillsRoot) {
      console.error(
        `[manta-fetcher] 警告: 找不到 packages/skills 源目录，跳过 Skill 安装（请在仓库内运行 init）\n`,
      );
    } else {
      const targets = buildSkillTargets(home).filter((t) => t.detect());
      const skills = readdirSync(skillsRoot).filter((name) =>
        existsSync(path.join(skillsRoot, name, 'SKILL.md')),
      );
      console.error('Skill:');
      for (const skill of skills) {
        for (const target of targets) {
          const dest = path.join(target.dir, skill);
          try {
            const existed = existsSync(dest);
            if (existed && dirsEqual(path.join(skillsRoot, skill), dest)) {
              console.error(`  = ${skill} → ${target.name}（已是最新）`);
              continue;
            }
            mkdirSync(target.dir, { recursive: true });
            cpSync(path.join(skillsRoot, skill), dest, { recursive: true });
            skillInstalled++;
            console.error(
              `  ✓ ${skill} → ${target.name}: ${rel(dest)}${existed ? '（已更新）' : ''}`,
            );
          } catch (e) {
            console.error(`  ✗ ${skill} → ${target.name}: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
      if (targets.length === 0) console.error('  （未检测到支持 skill 的客户端）');
      console.error('');
    }
  }

  console.error(
    `[manta-fetcher] 完成: MCP 写入 ${mcpInstalled} 个客户端` +
      (mcpSkipped ? `（跳过 ${mcpSkipped} 个已配置）` : '') +
      (skillInstalled ? `，Skill 更新 ${skillInstalled} 处` : ''),
  );
  console.error('重启对应客户端后生效；首次使用前确认 Chromium 已安装（pnpm setup）。');
}
