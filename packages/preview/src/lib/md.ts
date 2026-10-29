/**
 * Markdown 渲染：layoutToMarkdown 产物语法的子集（标题/段落/围栏代码/列表/表格/引用/图片/链接/行内标记）。
 * 输出 HTML 字符串；文本一律先转义，仅注入自产标签，样式用 Tailwind 工具类（生成元素无法走 className 传递）。
 */

const escHtml = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const IMG_TAG =
  '<img alt="$1" src="$2" loading="lazy" class="mx-auto my-4 block max-w-full rounded-lg" onerror="this.outerHTML=\'<span style=&quot;color:#86868b&quot;>（图片加载失败）</span>\'">';

// 标题公共样式 + 各级字号
const H_COMMON = 'mt-[1.3em] mb-[0.6em] leading-[1.4] font-semibold tracking-[-0.01em] text-[#1d1d1f]';
const H_SIZE = ['text-[1.8em]', 'text-[1.35em] border-b border-[#e5e5ea] pb-[0.35em]', 'text-[1.15em]', '', '', ''];

const CODE_INLINE = 'rounded bg-[#f5f5f7] px-[0.45em] py-[0.15em] font-mono text-[0.87em]';
const TD = 'border border-[#e5e5ea] px-[13px] py-[7px] text-left';

function inlineMd(s: string): string {
  let out = escHtml(s);
  out = out.replace(/`([^`]+)`/g, `<code class="${CODE_INLINE}">$1</code>`);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, IMG_TAG);
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer" class="text-[#007aff] no-underline hover:underline">$1</a>',
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^_])_([^_]+)_(?![a-zA-Z0-9])/g, '$1<em>$2</em>');
  return out;
}

export function mdToHtml(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let i = 0;
  // 列表用栈处理嵌套（2 空格一层）
  const listStack: Array<{ type: string }> = [];
  const closeListsTo = (depth: number) => {
    while (listStack.length > depth) {
      html.push(`</${listStack.pop()!.type}>`);
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // 围栏代码块（``` 或 ~~~~）
    const fence = line.match(/^(```|~~~~)(\w*)\s*$/);
    if (fence) {
      closeListsTo(0);
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^${fence[1]}`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合围栏
      html.push(
        `<pre class="my-4 overflow-auto rounded-lg bg-[#f5f5f7] px-[18px] py-4 text-[13px] leading-[1.6]"><code class="bg-transparent p-0">${escHtml(body.join('\n'))}</code></pre>`,
      );
      continue;
    }
    // 标题
    const h = line.match(/^(#{1,6}) (.*)$/);
    if (h) {
      closeListsTo(0);
      const n = h[1].length;
      html.push(`<h${n} class="${H_COMMON} ${H_SIZE[n - 1]}">${inlineMd(h[2])}</h${n}>`);
      i++;
      continue;
    }
    // 表格：| a | b |（第二行是 | --- | 分隔；[\s:|-] 允许分隔行内的竖线，否则多列表格识别不到）
    if (
      /^\|.+\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])
    ) {
      closeListsTo(0);
      const rows = [line];
      i += 2;
      while (i < lines.length && /^\|.+\|\s*$/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      const cells = (r: string, zebra: boolean) =>
        r
          .replace(/^\||\|\s*$/g, '')
          .split('|')
          .map((c) => `<td class="${TD}${zebra ? ' bg-[#fafafa]' : ''}">${inlineMd(c.trim())}</td>`)
          .join('');
      html.push(
        '<table class="my-4 w-full border-collapse text-[0.93em]">' +
          '<thead><tr>' +
          rows[0]
            .replace(/^\||\|\s*$/g, '')
            .split('|')
            .map((c) => `<th class="${TD} bg-[#f5f5f7] font-semibold">${inlineMd(c.trim())}</th>`)
            .join('') +
          '</tr></thead><tbody>' +
          rows
            .slice(1)
            .map((r, idx) => `<tr>${cells(r, idx % 2 === 1)}</tr>`)
            .join('') +
          '</tbody></table>',
      );
      continue;
    }
    // 引用块
    if (/^> /.test(line)) {
      closeListsTo(0);
      const body: string[] = [];
      while (i < lines.length && /^> /.test(lines[i])) {
        body.push(lines[i].replace(/^> /, ''));
        i++;
      }
      html.push(
        `<blockquote class="my-4 border-l-[3px] border-[#007aff] py-[0.4em] pl-[1.2em] pr-3 text-[#6e6e73]"><p class="my-0">${body.map(inlineMd).join('<br>')}</p></blockquote>`,
      );
      continue;
    }
    // 列表项（嵌套按 2 空格一层）
    const li = line.match(/^(\s*)([-]|\d+\.) (.*)$/);
    if (li) {
      const depth = Math.floor(li[1].length / 2);
      const type = li[2] === '-' ? 'ul' : 'ol';
      while (listStack.length > depth) html.push(`</${listStack.pop()!.type}>`);
      if (listStack.length === depth || listStack[listStack.length - 1].type !== type) {
        if (listStack.length > depth) html.push(`</${listStack.pop()!.type}>`);
        html.push(`<${type} class="my-[0.7em] pl-[1.8em]">`);
        listStack.push({ type });
      }
      html.push(`<li class="my-[0.3em]">${inlineMd(li[3])}</li>`);
      i++;
      continue;
    }
    // 独立图片段落
    const img = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/);
    if (img) {
      closeListsTo(0);
      html.push(`<p class="my-[0.9em]">${img[0].replace(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/, IMG_TAG)}</p>`);
      i++;
      continue;
    }
    // 空行 / 普通段落
    closeListsTo(0);
    if (line.trim()) html.push(`<p class="my-[0.9em]">${inlineMd(line)}</p>`);
    i++;
  }
  closeListsTo(0);
  return html.join('\n');
}
