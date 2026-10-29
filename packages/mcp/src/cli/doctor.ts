// `manta-fetcher doctor`：体检本机使用环境，预判接入常见问题。只读不改——需要写入/修复时
// 提示运行 `manta-fetcher init`（写入 MCP 配置与 Skill）或 `pnpm setup`（装 Chromium）。
//
// 输出形态（同 joybuddy doctor）：intro → spinner 逐项体检 → 聚合报告（@clack/prompts note
// 面板，按分组渲染，一个主体一行，状态符号打头，手动指引缩进附在所属行下）→ outro 汇总。
// 退出码：存在 error 级问题时为 1（脚本判断用）。
//
// 检查项（按内容归为三组）：
//   环境     Node ≥ 20 / Playwright Chromium 是否已安装 / dist 构建产物
//   Agent    各 AI 客户端的 manta-fetcher MCP 配置状态 + Skill 同步（同一行合并展示）；
//            未接入只是分析结果不算问题（需要接入时运行 manta-fetcher init）
//   采集配置 站点 Profile 加载 / 登录态 / 采集产物（0 个 profile 走通用兜底、无登录态
//            按需登录，都不算错误；采集产物为纯信息展示）

import * as p from '@clack/prompts';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { articlesCacheDir, authDir, profilesDir, ProfileRegistry } from '@manta-fetcher/core';
import { chromium } from 'playwright';
import { agentMcpStatuses, mcpCommand, skillSyncStatuses } from './init.js';
import { displayWidth, padLabel } from './format.js';
import { APP_VERSION } from './version.js';

// ---------- 体检结果模型（同 joybuddy doctor） ----------

type CheckStatus = 'ok' | 'warn' | 'error' | 'skip';

interface CheckResult {
  status: CheckStatus;
  message: string;
  /** 手动处理指引，缩进附在所属行下 */
  hint?: string;
}

interface Check {
  section: '环境' | 'Agent 接入' | '采集配置';
  /** 展示名（行首列，同组内对齐） */
  label: string;
  run: () => CheckResult | Promise<CheckResult>;
}

const STATUS_MARK: Record<CheckStatus, string> = { ok: '✔', warn: '⚠', error: '✖', skip: '·' };

const SECTION_ORDER: Array<Check['section']> = ['环境', 'Agent 接入', '采集配置'];

function nodeMajorOk(v: string): boolean {
  return Number.parseInt(v.split('.')[0] ?? '0', 10) >= 20;
}

/** 递归统计目录下 *.layout.json 数量（目录不存在算 0） */
function countLayoutFiles(dir: string): number {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.layout.json'),
    ).length;
  } catch {
    return 0;
  }
}

export async function runDoctor(): Promise<void> {
  const home = homedir();
  const rel = (p: string) => p.replace(home, '~');
  // 路径缩写：home 下用 ~，cwd 下用相对路径，其余原样 —— 面板行更短
  const shorten = (p: string): string => {
    const r = rel(p);
    if (r !== p) return r;
    return p.startsWith(process.cwd() + path.sep) ? path.relative(process.cwd(), p) : p;
  };

  const registry = new ProfileRegistry();
  await registry.reload();

  const checks: Check[] = [
    // ---------- 环境 ----------
    {
      section: '环境',
      label: 'Node',
      run: () =>
        nodeMajorOk(process.versions.node)
          ? { status: 'ok', message: `Node ${process.versions.node}` }
          : {
              status: 'error',
              message: `Node ${process.versions.node} 过旧`,
              hint: '升级到 Node 20+（浏览器引擎与 MCP SDK 均按此基线开发）',
            },
    },
    {
      section: '环境',
      label: 'Chromium',
      run: () => {
        const exe = chromium.executablePath();
        if (existsSync(exe)) return { status: 'ok', message: `已安装\n${shorten(exe)}` };
        return {
          status: 'error',
          message: '未检测到 Playwright Chromium',
          hint: '在仓库根目录执行 pnpm setup（或 pnpm exec playwright install chromium）',
        };
      },
    },
    {
      section: '环境',
      label: '构建产物',
      run: () => {
        const cmd = mcpCommand();
        // 仓库内运行时显示相对路径，面板更紧凑；仓库外（装包后）显示完整路径
        const abs = cmd.args[0] ?? '';
        const show = abs.startsWith(process.cwd() + path.sep)
          ? path.relative(process.cwd(), abs)
          : abs;
        return cmd.built
          ? { status: 'ok', message: show }
          : {
              status: 'error',
              message: `${show} 不存在`,
              hint: '在仓库根目录执行 pnpm build（各客户端配置指向这份文件）',
            };
      },
    },
    // ---------- Agent 接入（MCP 配置 + Skill 同步合并为一行） ----------
    ...agentMcpStatuses(home, mcpCommand()).map((agent) => ({
      section: 'Agent 接入' as const,
      label: agent.name,
      run: (): CheckResult => {
        if (!agent.detected) return { status: 'skip', message: '未安装' };
        const skills = skillSyncStatuses(home).filter((s) => s.agent === agent.name);
        const stale = skills.filter((s) => s.status !== 'latest');
        const parts: string[] = [];
        switch (agent.status) {
          case 'exists':
            parts.push('MCP ✓');
            break;
          case 'outdated':
            parts.push('MCP 不一致');
            break;
          case 'missing':
            parts.push('MCP 未写入');
            break;
        }
        if (skills.length) {
          parts.push(stale.length ? `skill 待同步（${stale.map((s) => s.skill).join('、')}）` : 'skill ✓');
        }
        const message = parts.join(' · ') || '未接入';
        if (agent.status === 'exists' && !stale.length) {
          return { status: 'ok', message };
        }
        return {
          status: agent.status === 'missing' ? 'skip' : 'warn',
          message,
          hint: '运行 manta-fetcher init 写入 / 更新 MCP 配置与 Skill',
        };
      },
    })),
    // ---------- 采集配置：Profile / 登录态 / 产物 ----------
    {
      section: '采集配置',
      label: '站点 Profile',
      run: () => {
        const profiles = registry.list();
        if (profiles.length === 0) {
          return {
            status: 'warn',
            message: `没有站点 Profile\n${shorten(profilesDir)}`,
            hint: '抓取会走通用兜底管线；添加 .yaml/.js profile 或设 MANTA_FETCHER_PROFILES_DIR 指向配置目录',
          };
        }
        return {
          status: 'ok',
          message: `${profiles.length} 个站点: ${profiles.map((x) => x.def.name).join('、')}\n${shorten(profilesDir)}`,
        };
      },
    },
    {
      section: '采集配置',
      label: '站点登录态',
      run: () => {
        let files: string[] = [];
        try {
          files = readdirSync(authDir).filter((f) => f.endsWith('.storage.json'));
        } catch {
          files = [];
        }
        if (files.length === 0) {
          return {
            status: 'skip',
            message: `${shorten(authDir)} 下尚无登录态`,
            hint: '需要登录的站点先调 login_<site> 工具或 manta-fetcher login <站点名> <URL>',
          };
        }
        return {
          status: 'ok',
          message: `${files.length} 个站点: ${files.map((f) => f.replace(/\.storage\.json$/, '')).join('、')}\n${shorten(authDir)}`,
        };
      },
    },
    {
      section: '采集配置',
      label: '采集产物',
      run: () => {
        const count = countLayoutFiles(articlesCacheDir);
        return count === 0
          ? { status: 'skip', message: `还没有布局 JSON\n${shorten(articlesCacheDir)}` }
          : { status: 'ok', message: `${count} 份布局 JSON\n${shorten(articlesCacheDir)}` };
      },
    },
  ];

  p.intro(`manta-fetcher doctor — 使用环境体检（v${APP_VERSION}，只读）`);

  // 逐项体检：spinner 提示当前项，单项抛错按 error 级呈现，不中断其余检查
  const spinner = p.spinner();
  const rows: Array<{ check: Check; result: CheckResult }> = [];
  for (const [i, check] of checks.entries()) {
    const text = `正在体检：${check.label}`;
    if (i === 0) spinner.start(text);
    else spinner.message(text);
    try {
      rows.push({ check, result: await Promise.resolve(check.run()) });
    } catch (err) {
      rows.push({
        check,
        result: {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
  spinner.stop('体检完成');

  renderReport(rows, rel);

  const count = (s: CheckStatus) => rows.filter((r) => r.result.status === s).length;
  const errors = count('error');
  p.outro(
    `体检完成：${count('ok')} 项通过` +
      (count('warn') ? `、${count('warn')} 项需注意` : '') +
      (errors ? `、${errors} 项失败` : '') +
      (count('skip') ? `、${count('skip')} 项未接入` : ''),
  );
  if (errors > 0) process.exitCode = 1;
}

/** 聚合渲染报告：分组装进一个 note 面板，◆ 分节头 + 组间空行，warn/error 指引缩进附在行下。 */
function renderReport(
  rows: Array<{ check: Check; result: CheckResult }>,
  rel: (p: string) => string,
): void {
  const blocks: string[][] = [];
  for (const section of SECTION_ORDER) {
    const sectionRows = rows.filter((r) => r.check.section === section);
    if (sectionRows.length === 0) continue;
    const lines: string[] = [`◆ ${section}`];
    const width = Math.max(...sectionRows.map((r) => displayWidth(r.check.label)));
    for (const { check, result } of sectionRows) {
      // 多行消息：首行跟在状态符号后，续行（如路径）独立缩进
      const [first, ...rest] = result.message.split('\n');
      lines.push(`  ${STATUS_MARK[result.status]} ${padLabel(check.label, width)}  ${first}`);
      for (const extra of rest) lines.push(`      ${extra}`);
      if (result.hint) {
        for (const [i, line] of result.hint.split('\n').entries()) {
          lines.push(`      ${i === 0 ? '→ ' : '  '}${line}`);
        }
      }
    }
    blocks.push(lines);
  }
  p.note(blocks.map((block) => block.join('\n')).join('\n\n'), 'manta-fetcher 体检报告');
}
