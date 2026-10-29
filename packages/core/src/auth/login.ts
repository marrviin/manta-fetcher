/**
 * 交互式登录：有头浏览器打开入口页，用户手动完成登录，登录态保存到 auth/<site>.storage.json。
 * - loginAndWait（MCP login_<site>）：轮询检测成功——session cookie 出现任一、URL 命中 successUrl、
 *   或缺省启发式（离开起始页且回到同站非登录页）；用户关闭浏览器/超时时已收集的 cookie 照常保留。
 * - interactiveLogin（CLI login）：用户登录后在终端回车确认，再保存登录态。
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { chromium, type BrowserContext } from 'playwright';
import { authDir, ensureDir, storageStatePath } from '../paths.js';

export interface LoginWaitOptions {
  /** 登录入口 URL（有头浏览器打开的起始页） */
  loginUrl: string;
  /** 登录成功判定：URL 匹配该正则/子串；缺省"离开起始页后回到同站非登录页" */
  successUrl?: string;
  /** 会话 cookie 名（逗号分隔）：存在任一即判定登录成功，比 URL 启发式可靠 */
  sessionCookie?: string;
  /** 轮询超时（ms，缺省 5 分钟） */
  timeoutMs?: number;
}

export interface LoginWaitResult {
  ok: boolean;
  /** 未成功时的原因（超时/用户关闭浏览器） */
  reason?: string;
  /** 登录态保存路径；无 cookie 时不保存、返回 undefined */
  savedPath?: string;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 保存登录态到 auth/<site>.storage.json；无 cookie 时不写、返回 undefined */
async function saveState(context: BrowserContext, site: string): Promise<string | undefined> {
  try {
    const state = await context.storageState();
    if (!state.cookies.length) return undefined;
    ensureDir(authDir);
    const file = storageStatePath(site);
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
    return file;
  } catch {
    return undefined; // context 已关闭等场景：已有文件保留不动
  }
}

/** 成功判定：session cookie → successUrl → 缺省 URL 启发式；返回命中方式描述或 null */
async function checkSuccess(
  context: BrowserContext,
  url: string,
  opts: LoginWaitOptions,
  startUrl: string,
): Promise<string | null> {
  const cookieNames = (opts.sessionCookie ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (cookieNames.length) {
    const names = new Set((await context.cookies()).map((c) => c.name));
    if (cookieNames.some((n) => names.has(n))) return '检测到会话 cookie';
    return null; // 声明了 sessionCookie 即以它为准，URL 启发式不再参与
  }
  if (opts.successUrl) {
    let matched: boolean;
    try {
      matched = new RegExp(opts.successUrl).test(url);
    } catch {
      matched = url.includes(opts.successUrl);
    }
    return matched ? 'URL 命中 successUrl' : null;
  }
  // 缺省启发式：离开起始页且回到同站、非登录页
  if (url === startUrl) return null;
  if (safeHost(url) !== safeHost(startUrl)) return null;
  if (/(login|signin|sign-in|signup|passport|oauth|auth)/i.test(url)) return null;
  return '离开登录页回到站点页面';
}

/** MCP login_<site>：打开有头浏览器等用户手动登录，每 2s 轮询检测，成功即保存登录态 */
export async function loginAndWait(
  site: string,
  opts: LoginWaitOptions,
): Promise<LoginWaitResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const statePath = storageStatePath(site);
  const browser = await chromium.launch({ headless: false });
  let closedByUser = false;
  browser.on('disconnected', () => {
    closedByUser = true;
  });
  try {
    const context = await browser.newContext({
      // 已有登录态带上再登：用户可能只需补一步验证，而非从零登录
      storageState: fs.existsSync(statePath) ? statePath : undefined,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await page.goto(opts.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const startUrl = page.url();

    const deadline = Date.now() + timeoutMs;
    let hit: string | null = null;
    let lastCookieCount = -1;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000).catch(() => {});
      if (closedByUser) break;
      try {
        hit = await checkSuccess(context, page.url(), opts, startUrl);
      } catch {
        continue; // 导航瞬态报错，下一轮再测
      }
      if (hit) break;
      // 轮询期间增量保存：用户中途关掉浏览器/进程被打断，已收集的 cookie 也不丢
      const count = (await context.cookies()).length;
      if (count !== lastCookieCount) {
        await saveState(context, site);
        lastCookieCount = count;
      }
    }

    const savedPath = await saveState(context, site);
    await browser.close().catch(() => {});
    if (hit) {
      return { ok: true, savedPath };
    }
    return {
      ok: false,
      reason: closedByUser
        ? '用户关闭了浏览器窗口'
        : savedPath
          ? '登录超时'
          : '登录超时，且未收集到任何 cookie',
      savedPath,
    };
  } catch (err) {
    await browser.close().catch(() => {});
    return {
      ok: false,
      reason: `登录流程异常：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** CLI login：有头浏览器打开起始页，用户手动登录后在终端回车确认，保存登录态 */
export async function interactiveLogin(site: string, startUrl: string): Promise<void> {
  const statePath = storageStatePath(site);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: fs.existsSync(statePath) ? statePath : undefined,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  console.log(`「${site}」登录中：请在打开的浏览器窗口完成登录。`);
  console.log('登录完成后回到终端按回车，登录态将保存到 ' + statePath);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => rl.once('line', resolve));
  rl.close();

  const savedPath = await saveState(context, site);
  await browser.close().catch(() => {});
  if (savedPath) {
    console.log(`登录态已保存: ${savedPath}`);
  } else {
    console.error('未收集到任何 cookie，登录态未保存。');
    process.exitCode = 1;
  }
}
