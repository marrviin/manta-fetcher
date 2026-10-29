import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { authDir, ensureDir, storageStatePath } from '../paths.js';

export interface ContextOptions {
  userAgent?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  /** 是否在进程退出时把该 context 的登录态保存到 auth/<site>.storage.json */
  persistAuth?: boolean;
  /**
   * CDP 接管端点（http://127.0.0.1:9222）：连接用户真实 Chrome 而非自启 Chromium。
   * 用于传输指纹级反爬站点——真实浏览器指纹与用户日常一致。
   * 注意：CDP 对端不应用 UA/viewport/storageState（以真实浏览器 profile 为准）。
   */
  cdpEndpoint?: string;
}

interface ContextEntry {
  promise: Promise<BrowserContext>;
  site: string;
  persist: boolean;
  cdpEndpoint?: string;
}

/**
 * 缺省 UA 伪装真实 Chrome：无头默认 UA 带 HeadlessChrome 标记，
 * 部分 CDN 对它直接返回 403 HTML（图片请求被 Chromium ORB 拦掉 → 页面图片全部加载失败）。
 * 通用反指纹伪装；站点级覆盖走 profile.navigation.userAgent。
 */
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 浏览器池：默认自启 Chromium（按站点隔离 context + storageState 持久化）；
 * cdpEndpoint 指定时连接用户真实 Chrome（登录态即浏览器自身，无需注入）。
 * 信号量限制并发页面数，避免同一站点被并发请求打爆。
 */
export class BrowserPool {
  private browser: Browser | null = null;
  /** CDP 模式的浏览器连接，按端点缓存 */
  private cdpBrowsers = new Map<string, Promise<Browser>>();
  private contexts = new Map<string, ContextEntry>();
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(private maxConcurrent = 4) {}

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
      this.browser.on('disconnected', () => {
        this.browser = null;
        this.contexts.clear();
      });
    }
    return this.browser;
  }

  /** CDP 端点 → 真实浏览器连接（按端点缓存，断开后自动清理） */
  private ensureCdpBrowser(endpoint: string): Promise<Browser> {
    let entry = this.cdpBrowsers.get(endpoint);
    if (!entry) {
      entry = chromium
        .connectOverCDP(endpoint, { timeout: 10_000 })
        .then((b) => {
          b.on('disconnected', () => {
            this.cdpBrowsers.delete(endpoint);
            for (const [key, e] of [...this.contexts.entries()]) {
              if (e.cdpEndpoint === endpoint) this.contexts.delete(key);
            }
          });
          return b;
        })
        .catch((err) => {
          this.cdpBrowsers.delete(endpoint);
          throw new Error(
            `CDP 连接失败（${endpoint}）：${err instanceof Error ? err.message : err}\n` +
              `请先以调试端口启动 Chrome：chrome --remote-debugging-port=9222` +
              (process.platform === 'darwin'
                ? `（macOS: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome）`
                : ''),
          );
        });
      this.cdpBrowsers.set(endpoint, entry);
    }
    return entry;
  }

  async contextFor(site: string, opts: ContextOptions = {}): Promise<BrowserContext> {
    const key = opts.cdpEndpoint ? `cdp:${opts.cdpEndpoint}:${site}` : site;
    let entry = this.contexts.get(key);
    if (!entry) {
      if (opts.cdpEndpoint) {
        // CDP 接管：复用真实浏览器的默认 context（其登录态、指纹即用户日常）
        const promise = (async () => {
          const browser = await this.ensureCdpBrowser(opts.cdpEndpoint!);
          const contexts = browser.contexts();
          return contexts[0] ?? (await browser.newContext());
        })();
        entry = { promise, site, persist: false, cdpEndpoint: opts.cdpEndpoint };
      } else {
        const statePath = storageStatePath(site);
        const promise = (async () => {
          const browser = await this.ensureBrowser();
          return browser.newContext({
            storageState: fs.existsSync(statePath) ? statePath : undefined,
            userAgent: opts.userAgent ?? DEFAULT_UA,
            viewport: opts.viewport ?? { width: 1280, height: 800 },
            locale: opts.locale,
            ignoreHTTPSErrors: true,
          });
        })();
        entry = { promise, site, persist: opts.persistAuth ?? true };
      }
      this.contexts.set(key, entry);
      entry.promise.catch(() => this.contexts.delete(key));
    }
    return entry.promise;
  }

  /** 丢弃某站点的缓存 context（登录态更新后调用，下次使用会重新加载 storageState） */
  async resetContext(site: string): Promise<void> {
    for (const [key, entry] of [...this.contexts.entries()]) {
      if (entry.site !== site) continue;
      this.contexts.delete(key);
      try {
        const ctx = await entry.promise;
        if (entry.persist) await ctx.close(); // CDP 对端的 context 属于真实浏览器，不关
      } catch {
        /* 已失效 */
      }
    }
  }

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next(); // 信号量名额直接转交给等待者
  }

  /** 保存登录态并关闭浏览器（CDP 连接只断开，不关用户的浏览器） */
  async close(): Promise<void> {
    for (const entry of this.contexts.values()) {
      try {
        const ctx = await entry.promise;
        if (entry.persist) {
          ensureDir(authDir);
          await ctx.storageState({ path: storageStatePath(entry.site) });
        }
        if (entry.persist) await ctx.close();
      } catch {
        // 关闭阶段失败可忽略
      }
    }
    this.contexts.clear();
    for (const endpoint of [...this.cdpBrowsers.keys()]) {
      const p = this.cdpBrowsers.get(endpoint);
      this.cdpBrowsers.delete(endpoint);
      p?.then((b) => b.close()).catch(() => {}); // close 仅断开 CDP 连接
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        /* ignore */
      }
      this.browser = null;
    }
  }
}
