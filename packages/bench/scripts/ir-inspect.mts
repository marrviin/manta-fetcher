/** 调试：离线加载 case 快照 → collect+enrich → 打印节点几何（x/w/y/h/字号/role/body），分析壳噪音用 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { collectLayoutFn, enrichLayout } from '@manta-fetcher/core';

const caseName = process.argv[2] ?? 'xueqiu-article';
const dir = `${process.env.HOME}/.manta-fetcher/cache/bench/${caseName}`;
const html = fs.readFileSync(`${dir}/snapshot.html`, 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' }).catch(() => {});
await page.waitForTimeout(500);
const pass = await page.evaluate(collectLayoutFn, { minSize: 10, maxNodes: 3000, textMax: 0 });
const extracted = enrichLayout(pass, { pageType: 'article' });
await browser.close();

for (const n of extracted.layout.nodes) {
  if (n.role === 'img') continue;
  const text = (n.runs ?? []).map((r) => r.t).join('').slice(0, 36).replace(/\n/g, ' ');
  console.log(
    `${n.body ? '★' : ' '} L${n.level} x=${String(n.rect[0]).padStart(4)} w=${String(n.rect[2]).padStart(4)} y=${String(n.rect[1]).padStart(5)} ${String(n.fontSize).padStart(3)}px ${n.role.padEnd(6)} ${text}`,
  );
}
