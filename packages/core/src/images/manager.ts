import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { ensureDir, imagesDir } from '../paths.js';

export type ImageMode = 'keep-url' | 'download' | 'inline';

export interface InlineImage {
  dataBase64: string;
  mimeType: string;
}

export interface ImageProcessResult {
  /** 原 URL → Markdown 中的新地址（本地相对路径或 #img-N 占位） */
  rewrite: Map<string, string>;
  /** inline 模式下按占位序号排列的图片内容块 */
  inline: InlineImage[];
  /** 最终图片清单（用于元信息） */
  resolved: { src: string; alt: string; local?: string }[];
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

const BASE64_BUDGET = 4 * 1024 * 1024; // inline 总预算，防止 token 爆炸

export class ImageManager {
  constructor(
    private site: string,
    private mode: ImageMode,
    private opts: { saveDir?: string; inlineMaxBytes?: number } = {},
  ) {}

  async process(items: { src: string; alt: string }[], context: BrowserContext): Promise<ImageProcessResult> {
    const result: ImageProcessResult = { rewrite: new Map(), inline: [], resolved: [] };
    if (items.length === 0) return result;
    if (this.mode === 'keep-url') {
      for (const it of items) {
        result.rewrite.set(it.src, it.src);
        result.resolved.push({ src: it.src, alt: it.alt });
      }
      return result;
    }

    const dir = path.resolve(this.opts.saveDir ?? path.join(imagesDir, this.site));
    if (this.mode === 'download') ensureDir(dir);

    let budget = BASE64_BUDGET;
    let seq = 0;
    const inlineMax = this.opts.inlineMaxBytes ?? 1_500_000;

    for (const item of items) {
      try {
        const res = await context.request.get(item.src, { timeout: 15_000 });
        if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
        const buf = Buffer.from(await res.body());
        const type = (res.headers()['content-type'] || 'image/jpeg').split(';')[0].trim();

        if (this.mode === 'download') {
          const ext = EXT_BY_TYPE[type] ?? 'img';
          const name = `${crypto.createHash('sha1').update(item.src).digest('hex').slice(0, 12)}.${ext}`;
          const file = path.join(dir, name);
          fs.writeFileSync(file, buf);
          const rel = path.relative(process.cwd(), file);
          result.rewrite.set(item.src, rel);
          result.resolved.push({ src: item.src, alt: item.alt, local: rel });
        } else {
          // inline：小图内联，大图保留 URL
          if (buf.length <= Math.min(inlineMax, budget)) {
            seq++;
            const placeholder = `#img-${seq}`;
            result.rewrite.set(item.src, placeholder);
            result.inline.push({ dataBase64: buf.toString('base64'), mimeType: type });
            budget -= buf.length;
            result.resolved.push({ src: item.src, alt: item.alt });
          } else {
            result.rewrite.set(item.src, item.src);
            result.resolved.push({ src: item.src, alt: item.alt });
          }
        }
      } catch (err) {
        // 下载失败保留原始 URL
        result.rewrite.set(item.src, item.src);
        result.resolved.push({ src: item.src, alt: item.alt });
        console.error(`[manta-fetcher] 图片下载失败 ${item.src}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return result;
  }
}
