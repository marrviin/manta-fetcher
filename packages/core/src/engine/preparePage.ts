/**
 * 浏览器端执行的一次性 DOM 预处理（page.evaluate 序列化后运行，必须自包含、无外部引用）。
 * 返回序列化好的正文 HTML + 元信息，Node 侧再转换为 Markdown。
 */

export interface PrepareArgs {
  mainContent?: string;
  remove?: string[];
  titleSelector?: string;
  structuredFields?: Record<
    string,
    {
      selector: string;
      multiple?: boolean;
      attribute?: string;
      limit?: number;
      fields?: Record<string, unknown>; // 嵌套子字段，结构同 StructuredField
    }
  >;
}

export interface PreparedImage {
  src: string;
  alt: string;
}

export interface PrepareResult {
  html: string;
  title: string;
  url: string;
  images: PreparedImage[];
  structured: Record<string, unknown> | null;
  /** true 表示未命中 Profile 选择器，走了通用启发式 */
  usedFallback: boolean;
}

export function preparePage(args: PrepareArgs): PrepareResult {
  // 开发态（tsx/esbuild keepNames）会向本函数注入 __name() 辅助调用，浏览器里没有该全局，补一个透传
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.__name !== 'function') g.__name = (fn: unknown) => fn;

  // 常量必须定义在函数体内：page.evaluate 只序列化函数本身，模块级变量不会随之传递
  /** 未指定 mainContent 时的常见正文容器候选，按顺序试 */
  const FALLBACK_SELECTORS = [
    'article',
    'main',
    '[role="main"]',
    '.markdown-body',
    '.article-content',
    '.post-content',
    '.entry-content',
    '#content',
    '.content',
  ];
  const SKIP_IMAGE_CHECK = new Set(['IMG', 'VIDEO', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT']);

  // ---- 0. 展开 Shadow DOM（Web Components 站点的正文常藏在 shadow root 里，如 MDN 的代码示例） ----
  // 只展开含正文级标签的 shadow root，避免把按钮/弹窗等 UI 组件也搬进来
  const CONTENT_TAGS = /<(pre|code|table|img|p|h[1-6]|ul|ol|dl|blockquote)\b/i;
  const expandShadow = (root: Document | ShadowRoot | Element): void => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const sr = (el as HTMLElement).shadowRoot;
      if (!sr) continue;
      expandShadow(sr);
      if (CONTENT_TAGS.test(sr.innerHTML)) {
        const container = document.createElement('div');
        container.innerHTML = sr.innerHTML;
        el.replaceWith(container);
      }
    }
  };
  expandShadow(document);

  // ---- 1. 定位正文 ----
  let main: Element | null = null;
  let usedFallback = false;
  const selectors = args.mainContent ? [args.mainContent] : ((usedFallback = true), FALLBACK_SELECTORS);
  for (const sel of selectors) {
    let els: Element[];
    try {
      els = Array.from(document.querySelectorAll(sel));
    } catch {
      continue; // 非法选择器
    }
    els = els.filter((e) => (e.textContent || '').trim().length > 80);
    if (els.length) {
      main = els.reduce((a, b) => ((b.textContent || '').length > (a.textContent || '').length ? b : a));
      break;
    }
  }
  if (!main) {
    main = document.body;
    usedFallback = true;
  }
  // 兜底模式下顺手移除常见噪音容器
  if (usedFallback) {
    for (const tag of ['nav', 'header', 'footer', 'aside', 'form']) {
      main.querySelectorAll(tag).forEach((e) => e.remove());
    }
  }

  // ---- 2. 按 Profile 移除 ----
  for (const sel of args.remove || []) {
    try {
      main.querySelectorAll(sel).forEach((e) => e.remove());
    } catch {
      /* 非法选择器跳过 */
    }
  }

  // ---- 3. 移除噪音与不可见元素 ----
  for (const el of Array.from(main.querySelectorAll('*'))) {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG') {
      el.remove();
      continue;
    }
    if (SKIP_IMAGE_CHECK.has(tag)) continue;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) {
      el.remove();
    }
  }

  // ---- 4. 图片：懒加载修正 + 绝对化 + 收集 ----
  const images: PreparedImage[] = [];
  const seen = new Set<string>();
  for (const img of Array.from(main.querySelectorAll('img'))) {
    let src = img.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) {
      for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-lazy']) {
        const v = img.getAttribute(attr);
        if (v) {
          src = v;
          break;
        }
      }
    }
    if (!src) {
      const source = img.closest('picture')?.querySelector('source');
      const srcset = source?.getAttribute('srcset') || img.getAttribute('srcset');
      if (srcset) {
        const cands = srcset
          .split(',')
          .map((s) => s.trim().split(/\s+/)[0])
          .filter(Boolean);
        if (cands.length) src = cands[cands.length - 1];
      }
    }
    if (!src || src.startsWith('data:')) {
      img.remove();
      continue;
    }
    try {
      src = new URL(src, document.baseURI).href;
    } catch {
      img.remove();
      continue;
    }
    img.setAttribute('src', src);
    img.removeAttribute('srcset');
    const alt = (img.getAttribute('alt') || '').trim();
    if (!seen.has(src)) {
      seen.add(src);
      images.push({ src, alt });
    }
  }

  // ---- 5. 链接绝对化（页内锚点保持 # 开头，Markdown 侧按纯文本处理避免标题全是链接） ----
  for (const a of Array.from(main.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) continue;
    try {
      a.setAttribute('href', new URL(href, document.baseURI).href);
    } catch {
      /* 非法 href 保留原样 */
    }
  }

  // ---- 6. 标题 ----
  let title = '';
  if (args.titleSelector) {
    try {
      title = document.querySelector(args.titleSelector)?.textContent?.trim() || '';
    } catch {
      /* ignore */
    }
  }
  if (!title) {
    const h1 = main.querySelector('h1');
    title = (h1?.textContent?.trim() || document.title || '').trim();
  }

  // ---- 7. 结构化字段（支持嵌套子字段：列表项抽成对象数组） ----
  interface FieldDef {
    selector: string;
    multiple?: boolean;
    attribute?: string;
    limit?: number;
    fields?: Record<string, FieldDef>;
  }
  const extractField = (scope: Element | Document, f: FieldDef): unknown => {
    // "&" 表示字段作用域元素自身（如从 a 元素的 fields 里直接取其 href）
    const els: Element[] =
      f.selector === '&'
        ? scope instanceof Element
          ? [scope]
          : []
        : (() => {
            let list: Element[];
            try {
              list = Array.from(scope.querySelectorAll(f.selector));
            } catch {
              list = [];
            }
            return f.limit ? list.slice(0, f.limit) : list;
          })();
    if (f.selector !== '&' && f.limit) els.length = Math.min(els.length, f.limit);
    const values = els
      .map((el) => {
        if (f.fields) {
          const obj: Record<string, unknown> = {};
          for (const [key, sub] of Object.entries(f.fields)) obj[key] = extractField(el, sub);
          return obj as unknown;
        }
        return f.attribute ? el.getAttribute(f.attribute) : (el.textContent || '').trim();
      })
      .filter((v) => v !== null && v !== '');
    return f.multiple ? values : (values[0] ?? null);
  };

  let structured: Record<string, unknown> | null = null;
  const fields = args.structuredFields;
  if (fields && Object.keys(fields).length > 0) {
    structured = {};
    for (const [key, f] of Object.entries(fields)) {
      structured[key] = extractField(document, f as FieldDef);
    }
  }

  return {
    html: main.outerHTML,
    title,
    url: location.href,
    images,
    structured,
    usedFallback,
  };
}
