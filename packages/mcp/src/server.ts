import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import {
  BrowserPool,
  effectiveProfile,
  FetchEngine,
  loginAndWait,
  ProfileRegistry,
  registerPreview,
  saveLayout,
  type EffectiveProfile,
  type LoadedProfile,
} from '@manta-fetcher/core';
import { APP_VERSION } from './cli/version.js';
import { buildToolList } from './tools.js';

export async function serve(): Promise<void> {
  const registry = new ProfileRegistry();
  await registry.reload();
  const pool = new BrowserPool(4);
  const engine = new FetchEngine(pool);

  const server = new Server(
    { name: 'manta-fetcher', version: APP_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await registry.reload(); // 支持热加载：新增 profile 文件即出现新工具
    return { tools: buildToolList(registry) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;
    try {
      await registry.reload();

      // 交互式登录工具：login_<site>
      if (registry.list().some((p) => p.loginToolName === name)) {
        const profile = registry.list().find((p) => p.loginToolName === name)!;
        const loginUrl = profile.def.auth?.loginUrl ?? profile.def.match[0]?.replace(/\*.*$/, '') ?? `https://${profile.def.name}`;
        const result = await loginAndWait(profile.def.name, {
          loginUrl,
          successUrl: profile.def.auth?.successUrl,
          sessionCookie: profile.def.auth?.sessionCookie,
        });
        // 丢弃旧 context，下次抓取带上刚保存的登录态
        await pool.resetContext(profile.def.name);
        return textResult(
          result.ok
            ? `「${profile.def.name}」登录成功，登录态已保存到 ${result.savedPath}。现在可以重试 ${profile.toolName} 抓取了。`
            : `「${profile.def.name}」登录未完成：${result.reason}` +
                (result.savedPath ? `（已保留 ${result.savedPath}，可直接重试抓取验证）` : '（未保存登录态）'),
          !result.ok,
        );
      }

      if (name === 'list_profiles') return listProfilesResult(registry);

      // 组合工具（列表 → N 详情）：依赖结构化字段 + markdown，本阶段 IR-only 暂不可用
      const compositeOwner = registry.list().find(
        (p) => p.def.composite && (p.def.composite.tool ?? `${p.toolName}_items`) === name,
      );
      if (compositeOwner) {
        return textResult(
          `组合抓取（列表 → N 详情）本阶段暂不可用：采集已切换为固定产出内容 IR（layout JSON），` +
            `结构化字段与 markdown 投影尚未接入。可先用 ${compositeOwner.toolName} 抓列表页 IR 查看。`,
          true,
        );
      }

      let profile: LoadedProfile | null = null;
      let url: string | undefined;
      if (name === 'fetch_page') {
        url = typeof args?.url === 'string' ? args.url : undefined;
        if (!url) return textResult(`缺少参数 url`, true);
        profile = registry.match(url);
      } else {
        profile = registry.byToolName(name);
        if (!profile) return textResult(`未知工具: ${name}（可用 list_profiles 查看已配置站点）`, true);
        url = typeof args?.url === 'string' ? args.url : undefined;
        if (!url) return textResult(`缺少参数 url`, true);
      }

      const eff: EffectiveProfile = effectiveProfile(profile?.def ?? null);
      // 需要登录的场景：无登录态时快速失败，指引 LLM 先调 login_<site>
      if (profile?.def.auth?.required && !fs.existsSync(eff.storageState ?? '')) {
        return textResult(authRequiredMessage(profile), true);
      }
      const result = await engine.fetch(url, eff);

      const content: CallToolResult['content'] = [
        {
          type: 'text',
          text:
            `**${result.title || '(无标题)'}**\n` +
            `来源: ${result.url} · 站点配置: ${result.site} · ` +
            `节点 ${result.layout.nodes.length}${result.layout.truncated ? '（已截断）' : ''}\n\n---\n\n` +
            JSON.stringify({ ...result.layout }, null, 2),
        },
      ];

      const out: CallToolResult = { content, isError: false };
      out.structuredContent = {
        site: result.site,
        url: result.url,
        title: result.title,
        truncated: result.layout.truncated ?? false,
        nodeCount: result.layout.nodes.length,
      };

      // preview：注册进本地预览 server（模板+JSON 分离），返回 URL 并自动打开
      if (args?.preview === true) {
        const previewUrl = await registerPreview(result.layout, {
          title: result.title || result.url,
          url: result.url,
          fetchedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        });
        out.content.push({
          type: 'text',
          text: `\n---\n【布局预览】${previewUrl}（已在浏览器打开；server 随 MCP 进程存续，同会话多次 preview 会在左侧列表累积）`,
        });
      }

      // 默认落盘：IR 是采集的固定产出，目录固定在项目级 dataRoot/cache/articles
      // （preview 左侧列表会现扫该目录）；saveTo: false 显式跳过
      if (args?.saveTo !== false && args?.saveTo !== 'false') {
        const saved = saveLayout(result, {
          slug:
            typeof args?.saveSlug === 'string' && args.saveSlug
              ? args.saveSlug
              : result.title || undefined,
        });
        (out.structuredContent as Record<string, unknown>).saved = saved;
        out.content.push({ type: 'text', text: `\n---\n已保存: ${saved.file}` });
      }
      return out;
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  });

  // 优雅退出：保存各站点登录态
  const shutdown = async () => {
    await pool.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[manta-fetcher] MCP server 已启动 (v${APP_VERSION})，profiles 目录: ${registry.list().length} 个站点配置`);
}

function authRequiredMessage(profile: LoadedProfile): string {
  return (
    `站点「${profile.def.name}」的该场景需要登录态。\n` +
    `请调用工具 ${profile.loginToolName}：会打开浏览器窗口，由用户手动完成登录，登录态自动保存；完成后重试本操作即可。`
  );
}

function listProfilesResult(registry: ProfileRegistry): CallToolResult {
  const profiles = registry.list();
  if (profiles.length === 0) {
    return textResult(
      '当前没有已配置的站点 Profile。在项目根目录 profiles/ 下添加 .yaml 或 .js 文件即可（热加载）。',
    );
  }
  const lines = profiles.map(
    (p) =>
      `- **${p.def.name}** → 工具 \`${p.toolName}\`` +
      (p.def.match.length ? `\n  匹配: ${p.def.match.join(', ')}` : '') +
      (p.def.description ? `\n  ${p.def.description}` : ''),
  );
  return textResult(`已配置 ${profiles.length} 个站点 Profile:\n\n${lines.join('\n')}`);
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}
