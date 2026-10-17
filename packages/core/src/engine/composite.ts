import type { LoadedProfile } from '../profiles/schema.js';

export interface CompositeItem {
  list: Record<string, unknown>;
  /** 详情页抓取结果；detailFetch 失败时为 error */
  detail?: {
    title: string;
    url: string;
    site: string;
    markdown: string;
    images: { src: string; alt: string; local?: string }[];
    /** saveTo 落盘时由 server 附加（internal） */
    saved?: { file: string; metaFile?: string };
  };
  error?: string;
}

export interface CompositeResult {
  tool: string;
  listUrl: string;
  items: CompositeItem[];
}

export interface CompositeDeps {
  /** 抓列表页并返回结构化字段（server 已处理登录指引） */
  fetchList: (url: string) => Promise<Record<string, unknown>>;
  /** 抓一个详情页 */
  fetchDetail: (url: string) => Promise<NonNullable<CompositeItem['detail']>>;
  /** 可选：在列表页同一会话中解析中转跳转，返回最终 URL（如搜狗 /link?url= → mp.weixin.qq.com） */
  resolveRedirect?: (intermediateUrl: string, listUrl: string) => Promise<string>;
}

/**
 * 通用"列表页 → N 个详情页"编排。profile 通过 composite 声明，本函数不认识任何具体站点。
 * url 来源：列表结构化字段顶层每个字段若是对象数组，取其元素中的 urlField（缺省 "url"）。
 */
export async function runComposite(
  listUrl: string,
  composite: NonNullable<LoadedProfile['def']['composite']>,
  deps: CompositeDeps,
): Promise<CompositeResult> {
  const urlField = composite.urlField ?? 'url';
  const absolutize = composite.absolutizeUrl ?? true;
  const fields = await deps.fetchList(listUrl);

  // 收集候选 URL：遍历所有顶层字段，取对象数组元素里的 urlField
  const candidates: { list: Record<string, unknown>; url: string }[] = [];
  for (const value of Object.values(fields)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (entry && typeof entry === 'object') {
        let url = (entry as Record<string, unknown>)[urlField];
        if (typeof url !== 'string' || url.length === 0) continue;
        if (absolutize && !/^https?:\/\//.test(url)) {
          try {
            url = new URL(url, listUrl).href;
          } catch {
            continue;
          }
        }
        if (typeof url === 'string' && /^https?:\/\//.test(url)) {
          candidates.push({ list: entry as Record<string, unknown>, url });
        }
      }
    }
  }
  // 列表为空 = 页面未渲染完/被反爬/选择器失效，报错让调用方重试而不是静默返回空
  if (candidates.length === 0) {
    throw new Error(
      `组合抓取失败：列表页未解析出任何含 ${urlField} 的条目（页面可能未加载完、被拦截，或 profile 选择器已失效）— ${listUrl}`,
    );
  }

  const items: CompositeItem[] = [];
  const limit = composite.detailLimit ?? candidates.length;
  for (const candidate of candidates.slice(0, limit)) {
    try {
      const target =
        composite.resolveRedirect && deps.resolveRedirect
          ? await deps.resolveRedirect(candidate.url, listUrl)
          : candidate.url;
      const detail = await deps.fetchDetail(target);
      items.push({ list: candidate.list, detail });
    } catch (err) {
      items.push({ list: candidate.list, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { tool: composite.tool ?? 'composite', listUrl, items };
}
