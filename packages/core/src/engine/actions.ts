import type { Page } from 'playwright';
import type { ProfileAction } from '../profiles/schema.js';

/** 滚动到底触发懒加载/无限流，连续滚动无增长则提前结束 */
export async function autoScroll(page: Page, maxScrolls = 15, delayMs = 400): Promise<void> {
  await page.evaluate(
    async ({ max, delay }) => {
      await new Promise<void>((resolve) => {
        let scrolled = 0;
        let lastY = -1;
        let stagnant = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 900);
          scrolled++;
          if (window.scrollY === lastY) stagnant++;
          else stagnant = 0;
          lastY = window.scrollY;
          if (scrolled >= max || stagnant >= 4) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, delay);
      });
    },
    { max: maxScrolls, delay: delayMs },
  );
}

export async function runActions(page: Page, actions: ProfileAction[] | undefined): Promise<void> {
  if (!actions) return;
  for (const action of actions) {
    if ('scroll' in action && action.scroll) {
      await autoScroll(page, action.scroll.maxScrolls ?? 15, action.scroll.delayMs ?? 400);
    } else if ('click' in action && action.click) {
      await page.click(action.click.selector, { timeout: 10_000 }).catch(() => {});
    } else if ('wait' in action && action.wait) {
      if ('ms' in action.wait) {
        await page.waitForTimeout(action.wait.ms);
      } else if ('selector' in action.wait) {
        await page.waitForSelector(action.wait.selector, { timeout: 15_000 }).catch(() => {});
      }
    }
  }
}

/**
 * 处理 waitUntil 中的追加等待语法：
 * - "visible:<selector>"：等选择器可见
 * - "ms:<n>"：固定等待
 * load/domcontentloaded/networkidle/commit 已由 goto 处理，这里跳过
 */
export async function runExtraWait(page: Page, waitUntil: string | undefined, timeoutMs: number): Promise<void> {
  if (!waitUntil) return;
  if (waitUntil.startsWith('visible:')) {
    await page
      .waitForSelector(waitUntil.slice('visible:'.length), { state: 'visible', timeout: timeoutMs })
      .catch(() => {});
  } else if (waitUntil.startsWith('ms:')) {
    const ms = Number(waitUntil.slice(3));
    if (Number.isFinite(ms) && ms > 0) await page.waitForTimeout(ms);
  }
}

export const GOTO_WAIT_UNTILS = ['load', 'domcontentloaded', 'networkidle', 'commit'] as const;
