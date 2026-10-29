// `manta-fetcher tools`：列出 MCP server 会注册的全部工具（名称 + 描述），不启动 stdio server。
// 与 serve 共用 buildToolList，包含各站点 profile 热加载出的工具与登录工具，调 Profile 时可快速核对。
// 输出为 @clack/prompts note 面板（名称列按显示宽度对齐，CJK 记 2 列）。
import * as p from '@clack/prompts';
import { ProfileRegistry } from '@manta-fetcher/core';
import { buildToolList } from '../tools.js';
import { displayWidth, padLabel } from './format.js';

export async function runTools(): Promise<void> {
  const registry = new ProfileRegistry();
  await registry.reload();
  const tools = buildToolList(registry);

  const width = Math.max(...tools.map((t) => displayWidth(t.name)));
  const lines = tools.map((t) => `  ${padLabel(t.name, width)}  ${t.description ?? ''}`);
  p.note(lines.join('\n'), `MCP 工具清单（${tools.length} 个，与 serve 注册一致，profiles 热加载）`);
  p.log.info('试抓: manta-fetcher test <URL> [站点名]；体检环境: manta-fetcher doctor');
}
