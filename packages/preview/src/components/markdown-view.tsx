import { mdToHtml } from '../lib/md';
import type { LayoutDetail } from '../types';

export default function MarkdownView({ entry }: { entry: LayoutDetail }) {
  const html = entry.markdown
    ? mdToHtml(entry.markdown)
    : '<p class="text-[#86868b]">该条目没有 Markdown 投影（重新采集一次即可）</p>';
  return (
    <div
      className="w-full max-w-[860px] shrink-0 rounded-xl border border-[#e5e5ea] bg-white px-14 py-11 text-[15px] leading-[1.8] break-words text-[#1d1d1f] [&>*:first-child]:mt-0"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
