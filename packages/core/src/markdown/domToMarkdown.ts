import { parseHTML } from 'linkedom';

export interface MarkdownOptions {
  /** 标题层级偏移：2 表示正文里的 h1 输出为 ### */
  headingOffset?: number;
}

const INLINE_ONLY = /^(A|ABBR|B|BDI|BDO|BR|CITE|CODE|DATA|DFN|EM|I|KBD|MARK|Q|RP|RT|RUBY|S|SAMP|SMALL|SPAN|STRONG|SUB|SUP|TIME|U|VAR|WBR|DEL|INS)$/;

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function escapeLinkText(text: string): string {
  return text.replace(/[[\]]/g, '\\$&');
}

function escapeHref(href: string): string {
  return href.replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : '%20'));
}

export function htmlToMarkdown(html: string, opts: MarkdownOptions = {}): string {
  const headingOffset = Math.min(Math.max(opts.headingOffset ?? 0, 0), 5);
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const body = document.body;
  if (!body) return '';

  const out: string[] = [];
  walkBlocks(body, out);
  return normalize(out.join('\n\n'));

  // ---------- 块级遍历 ----------

  function walkBlocks(el: Element, out: string[]): void {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        const t = cleanText(child.textContent || '');
        if (t.trim()) out.push(t.trim());
      } else if (child.nodeType === 1) {
        renderBlock(child as Element, out);
      }
    }
  }

  function renderBlock(el: Element, out: string[]): void {
    const tag = el.tagName;

    if (/^H[1-6]$/.test(tag)) {
      const level = Math.min(Number(tag[1]) + headingOffset, 6);
      const text = inlineOf(el).trim();
      if (text) out.push(`${'#'.repeat(level)} ${text}`);
      return;
    }
    if (tag === 'P') {
      const text = inlineOf(el).replace(/\n{2,}/g, '\n').trim();
      if (text) out.push(text);
      return;
    }
    if (tag === 'PRE') {
      const code = el.querySelector('code');
      const raw = (code?.textContent ?? el.textContent ?? '').replace(/\n$/, '');
      const lang =
        code?.className.match(/(?:language|lang|highlight)-([\w+#.-]+)/)?.[1] ??
        el.className.match(/(?:language|lang)-([\w+#.-]+)/)?.[1] ??
        '';
      const fence = raw.includes('```') ? '````' : '```';
      out.push(`${fence}${lang}\n${raw}\n${fence}`);
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      const lines = renderList(el, 0, tag === 'OL');
      if (lines.length) out.push(lines.join('\n'));
      return;
    }
    if (tag === 'LI') {
      // 异常位置的 li，按列表项行处理
      const text = inlineOf(el).trim();
      if (text) out.push(`- ${text}`);
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      const tmp: string[] = [];
      walkBlocks(el, tmp);
      const joined = tmp.join('\n\n');
      if (joined.trim()) out.push(joined.split('\n').map((l) => `> ${l}`).join('\n'));
      return;
    }
    if (tag === 'TABLE') {
      const md = renderTable(el);
      if (md) out.push(md);
      return;
    }
    if (tag === 'HR') {
      out.push('---');
      return;
    }
    if (tag === 'IMG') {
      const md = imageMd(el);
      if (md) out.push(md);
      return;
    }
    if (tag === 'FIGCAPTION') {
      const text = inlineOf(el).trim();
      if (text) out.push(`*${text}*`);
      return;
    }
    if (tag === 'FIGURE' || tag === 'PICTURE') {
      walkBlocks(el, out);
      return;
    }
    if (tag === 'IFRAME') {
      const src = el.getAttribute('src');
      if (src) out.push(`[嵌入内容](${src})`);
      return;
    }
    if (tag === 'VIDEO' || tag === 'AUDIO') {
      const src = el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || '';
      if (src) out.push(`[媒体文件](${src})`);
      return;
    }
    if (tag === 'DL') {
      const lines: string[] = [];
      for (const child of Array.from(el.children)) {
        if (child.tagName === 'DT') {
          const t = inlineOf(child).trim();
          if (t) lines.push(`**${t}**`);
        } else if (child.tagName === 'DD') {
          const t = inlineOf(child).trim();
          if (t) lines.push(t);
        }
      }
      if (lines.length) out.push(lines.join('\n'));
      return;
    }
    if (tag === 'BR') return;

    // DIV/SECTION/ARTICLE 等容器，或块级上下文中的行内元素
    const hasBlockChild = Array.from(el.children).some((c) => !INLINE_ONLY.test(c.tagName));
    if (hasBlockChild) {
      walkBlocks(el, out);
    } else {
      const text = inlineOf(el).replace(/\n{2,}/g, '\n').trim();
      if (text) out.push(text);
    }
  }

  // ---------- 列表 ----------

  function renderList(listEl: Element, indent: number, ordered: boolean): string[] {
    const pad = ' '.repeat(indent);
    const lines: string[] = [];
    let idx = Number(listEl.getAttribute('start')) || 1;

    for (const li of Array.from(listEl.children)) {
      if (li.tagName !== 'LI') continue;
      const marker = ordered ? `${idx++}. ` : '- ';
      const nested: Element[] = [];
      const headNodes: Node[] = [];
      for (const child of Array.from(li.childNodes)) {
        if (child.nodeType === 1 && (child as Element).tagName === 'UL') nested.push(child as Element);
        else if (child.nodeType === 1 && (child as Element).tagName === 'OL') nested.push(child as Element);
        else headNodes.push(child);
      }
      const content = inlineOfNodes(headNodes).replace(/\n{2,}/g, '\n').trim();
      const contentLines = content.split('\n').filter((l) => l.trim());
      lines.push(pad + marker + (contentLines[0] ?? ''));
      const contPad = pad + ' '.repeat(marker.length);
      for (const l of contentLines.slice(1)) lines.push(contPad + l.trim());
      for (const n of nested) {
        lines.push(...renderList(n, indent + marker.length, n.tagName === 'OL'));
      }
    }
    return lines;
  }

  // ---------- 表格 ----------

  function renderTable(table: Element): string {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const cellOf = (cell: Element): string =>
      inlineOf(cell)
        .replace(/\n+/g, '<br>')
        .replace(/\|/g, '\\|')
        .trim();

    const matrix = rows.map((r) => Array.from(r.children).filter((c) => /^(TD|TH)$/.test(c.tagName)).map(cellOf));
    const colCount = Math.max(...matrix.map((r) => r.length), 1);
    for (const row of matrix) while (row.length < colCount) row.push('');

    // 表头：thead 里的行，否则第一行
    const theadRows = table.querySelectorAll('thead tr').length;
    const headerRowCount = theadRows > 0 ? Math.min(theadRows, matrix.length) : 1;
    const header = matrix.slice(0, headerRowCount).map((r) => r.join(' | '));
    const body = matrix.slice(headerRowCount);
    const separator = Array.from({ length: colCount }, () => '---').join(' | ');

    const lines = [...header, separator, ...body.map((r) => r.join(' | '))];
    return lines.map((l) => `| ${l} |`).join('\n');
  }

  // ---------- 行内遍历 ----------

  function inlineOf(el: Element): string {
    return inlineOfNodes(Array.from(el.childNodes));
  }

  function inlineOfNodes(nodes: Node[]): string {
    let s = '';
    for (const node of nodes) s += inlineNode(node);
    return s;
  }

  function inlineNode(node: Node): string {
    if (node.nodeType === 3) return cleanText(node.textContent || '');
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    const tag = el.tagName;

    if (tag === 'BR') return '\n';
    if (tag === 'IMG') return imageMd(el);
    if (tag === 'A') {
      const href = el.getAttribute('href');
      const inner = inlineOf(el).replace(/\n+/g, ' ').trim();
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) return inner;
      return `[${escapeLinkText(inner) || escapeHref(href)}](${escapeHref(href)})`;
    }
    if (tag === 'STRONG' || tag === 'B') {
      const inner = inlineOf(el).replace(/\n+/g, ' ').trim();
      return inner ? `**${inner}**` : '';
    }
    if (tag === 'EM' || tag === 'I') {
      const inner = inlineOf(el).replace(/\n+/g, ' ').trim();
      return inner ? `_${inner}_` : '';
    }
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') {
      const inner = inlineOf(el).replace(/\n+/g, ' ').trim();
      return inner ? `~~${inner}~~` : '';
    }
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
      const raw = el.textContent || '';
      if (!raw.trim()) return '';
      const runs = raw.match(/`+/g);
      const fence = '`'.repeat(Math.max(0, ...(runs ?? []).map((r) => r.length)) + 1);
      return `${fence}${raw}${fence}`;
    }
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG' || tag === 'IFRAME') {
      return '';
    }
    // 行内容器（span/u/mark/sup/sub/…）或块级元素出现在行内位置：递归展开
    return inlineOfNodes(Array.from(el.childNodes));
  }

  function imageMd(el: Element): string {
    const src = el.getAttribute('src');
    if (!src) return '';
    const alt = (el.getAttribute('alt') || '').replace(/[[\]]/g, '');
    return `![${alt}](${escapeHref(src)})`;
  }

  function normalize(md: string): string {
    return md
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
