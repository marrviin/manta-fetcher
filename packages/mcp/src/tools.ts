// MCP 工具清单的唯一来源：serve 时注册（server.ts）与 `manta-fetcher tools` 展示（cli/tools.ts）
// 共用 buildToolList，保证两边永远一致。
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ProfileRegistry } from '@manta-fetcher/core';

export const FETCH_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    url: { type: 'string', description: '要抓取的页面 URL' },
    saveTo: {
      type: 'boolean',
      description:
        '传 false 跳过落盘。缺省落盘到 cache/articles（在 git 项目内为 <项目根>/.manta-fetcher/cache/articles，否则为启动目录 <cwd>/.manta-fetcher/cache/articles；目录固定，不可自定义）',
    },
    saveSlug: { type: 'string', description: '落盘文件名 slug，缺省用页面标题' },
    preview: {
      type: 'boolean',
      description:
        '启动本地预览 server 渲染布局（HTML 模板 + IR JSON 分离，同会话多次 preview 在页面左侧累积切换）',
    },
  },
  required: ['url'],
};

/** 列出会注册的全部工具：fetch_page + 各站点 profile 工具（及其登录工具）+ list_profiles */
export function buildToolList(registry: ProfileRegistry): Tool[] {
  const tools: Tool[] = [
    {
      name: 'fetch_page',
      description:
        '抓取任意网页并返回页面内容 IR（JSON：块级节点 role+行内 runs+坐标/字号/重要性 + 图片节点）。' +
        'URL 命中已配置站点时自动使用该站点的定制规则，否则走通用管线。',
      inputSchema: FETCH_INPUT_SCHEMA,
    },
  ];
  for (const p of registry.list()) {
    tools.push({
      name: p.toolName,
      description:
        p.def.description ??
        `抓取 ${p.def.name} 站点页面，返回页面内容 IR（JSON）` +
          (p.def.match.length ? `（适用: ${p.def.match.join(', ')}）` : ''),
      inputSchema: FETCH_INPUT_SCHEMA,
    });
    // 声明了登录要求的站点，同时注册交互式登录工具
    if (p.def.auth?.required || p.def.auth?.loginUrl) {
      tools.push({
        name: p.loginToolName,
        description:
          `打开浏览器窗口让用户手动登录「${p.def.name}」，登录态自动保存，之后即可用 ${p.toolName} 抓取。` +
          `入口: ${p.def.auth?.loginUrl ?? '站点页面'}。仅当用户同意或场景明确要求登录时调用。`,
        inputSchema: { type: 'object', properties: {} },
      });
    }
  }
  tools.push({
    name: 'list_profiles',
    description: '列出 manta-fetcher 已配置的站点采集 Profile 及其能力',
    inputSchema: { type: 'object', properties: {} },
  });
  return tools;
}
