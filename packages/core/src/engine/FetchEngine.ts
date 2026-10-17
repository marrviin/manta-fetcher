import type { SiteProfile } from "../profiles/schema.js";
import { GOTO_WAIT_UNTILS, runActions, runExtraWait } from "./actions.js";
import { BrowserPool } from "./BrowserPool.js";
import {
  collectLayoutFn,
  enrichLayout,
  warmPageForLayout,
  type ExtractResult,
  type ExtractArgs,
  type PageLayout,
  type RawPass,
} from "../layout/boxTree.js";
import { screenshotsDir, storageStatePath } from "../paths.js";
import { ensureDir } from "../paths.js";
import path from "node:path";

/** 合并通用默认值后的有效配置 */
export interface EffectiveProfile {
  name: string;
  waitUntil: string;
  timeoutMs: number;
  userAgent?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  actions?: SiteProfile["actions"];
  mainContent?: string;
  remove?: string[];
  titleSelector?: string;
  headingOffset: number;
  storageState?: string;
  /** 抓取后 URL 命中该正则 → 登录态失效 */
  loginRedirect?: string;
  /** CDP 接管端点：连接用户真实 Chrome（传输指纹级反爬站点用） */
  cdpEndpoint?: string;
  prepare?: (
    page: import("playwright").Page,
    ctx: { url: string },
  ) => Promise<void>;
}

/** navigation.browser 语法："cdp:<endpoint>"，其余写法不启用 CDP */
function parseCdpEndpoint(browser?: string): string | undefined {
  if (!browser) return undefined;
  if (browser.startsWith("cdp:")) {
    const endpoint = browser.slice(4).trim() || "http://127.0.0.1:9222";
    return endpoint;
  }
  return undefined;
}

export function effectiveProfile(def: SiteProfile | null): EffectiveProfile {
  const name = def?.name ?? "generic";
  return {
    name,
    waitUntil: def?.navigation?.waitUntil ?? "load",
    timeoutMs: def?.navigation?.timeoutMs ?? 30_000,
    userAgent: def?.navigation?.userAgent,
    viewport: def?.navigation?.viewport,
    locale: def?.navigation?.locale,
    actions: def?.actions,
    mainContent: def?.extraction?.mainContent,
    remove: def?.extraction?.remove,
    titleSelector: def?.extraction?.title,
    headingOffset: def?.markdown?.headingOffset ?? 0,
    storageState: def?.auth?.storageState
      ? path.resolve(def.auth.storageState)
      : storageStatePath(name),
    loginRedirect: def?.auth?.loginRedirect,
    cdpEndpoint: parseCdpEndpoint(def?.navigation?.browser),
  };
}

/** 采集固定产出：页面内容 IR（enriched layout）+ 页面元信息 */
export interface FetchResult {
  title: string;
  url: string;
  site: string;
  /** 内容 IR：块级节点（role + runs + 坐标/字号/重要性）+ 图片节点 */
  layout: PageLayout;
  screenshotPath?: string;
}

export class FetchEngine {
  constructor(private pool: BrowserPool) {}

  async fetch(url: string, eff: EffectiveProfile): Promise<FetchResult> {
    const context = await this.pool.contextFor(eff.name, {
      userAgent: eff.userAgent,
      viewport: eff.viewport,
      locale: eff.locale,
      cdpEndpoint: eff.cdpEndpoint,
    });
    await this.pool.acquire();
    const page = await context.newPage();
    let screenshotPath: string | undefined;
    try {
      const gotoWait = (GOTO_WAIT_UNTILS as readonly string[]).includes(
        eff.waitUntil,
      )
        ? (eff.waitUntil as "load")
        : "domcontentloaded";
      await page.goto(url, { waitUntil: gotoWait, timeout: eff.timeoutMs });
      await runExtraWait(page, eff.waitUntil, eff.timeoutMs);
      // 登录态失效检测：被重定向到登录页
      if (eff.loginRedirect) {
        let redirected = false;
        try {
          redirected = new RegExp(eff.loginRedirect).test(page.url());
        } catch {
          redirected = page.url().includes(eff.loginRedirect);
        }
        if (redirected) {
          throw new Error(
            `登录态已失效（被重定向到登录页）。请调用该站点的 login 工具重新登录后重试。`,
          );
        }
      }
      await runActions(page, eff.actions);
      await eff.prepare?.(page, { url });

      // 暖场滚动：触发懒加载并等图片撑开盒子，保证 IR 坐标与图片完整；
      // 内部滚动容器页面（joyspace 虚拟滚动）从 mainContent 向上找滚动容器预热
      await warmPageForLayout(page, 8000, eff.mainContent);

      // IR 采集：浏览器侧 collectLayoutFn 定位（mainContent/remove 裁剪）+ 多趟原始采集，
      // Node 侧 enrichLayout 完成聚类统计与评分
      const args: ExtractArgs = {
        mainContent: eff.mainContent,
        remove: eff.remove,
        titleSelector: eff.titleSelector,
      };
      const pass: RawPass = await page.evaluate(collectLayoutFn, args);
      const extracted: ExtractResult = enrichLayout(pass);

      return {
        title: extracted.title,
        url: extracted.url,
        site: eff.name,
        layout: extracted.layout,
        screenshotPath,
      };
    } catch (err) {
      // 失败截图，路径带回给调用方便于诊断
      try {
        ensureDir(screenshotsDir);
        screenshotPath = path.join(screenshotsDir, `fail-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
      } catch {
        screenshotPath = undefined;
      }
      const shot = screenshotPath
        ? `（已保存失败截图: ${screenshotPath}）`
        : "";
      throw new Error(
        `抓取失败: ${url}\n  ${err instanceof Error ? err.message : String(err)}${shot}`,
      );
    } finally {
      await page.close().catch(() => {});
      this.pool.release();
    }
  }

  /**
   * 在 site 的浏览器会话中打开 intermediateUrl 并跟随跳转（含 JS 跳转，如搜狗 /link?url=），
   * 返回最终落点 URL。用于 composite.resolveRedirect：中转链的 token 依赖列表页会话。
   */
  async resolveRedirect(
    site: string,
    intermediateUrl: string,
    timeoutMs = 20_000,
    cdpEndpoint?: string,
  ): Promise<string> {
    const context = await this.pool.contextFor(site, { cdpEndpoint });
    await this.pool.acquire();
    const page = await context.newPage();
    try {
      await page.goto(intermediateUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      // 等待跳转稳定：URL 连续 2s 不变（搜狗的跳转页由 JS 触发 location.replace）
      let lastUrl = page.url();
      let stableSince = Date.now();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await page.waitForTimeout(500);
        const url = page.url();
        if (url !== lastUrl) {
          lastUrl = url;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 2000) {
          break;
        }
      }
      return lastUrl;
    } finally {
      await page.close().catch(() => {});
      this.pool.release();
    }
  }
}
