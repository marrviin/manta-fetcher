import { Layout, Segmented, Collapse } from 'antd';
import type { EntrySource, LayoutSummary, ViewMode } from '../types';
import { dateLabel, normalizeDate } from '../lib/dates';

interface SidebarProps {
  list: LayoutSummary[];
  currentId?: string;
  viewModes: Record<string, ViewMode>;
  onPick: (id: string) => void;
  onModeChange: (id: string, mode: ViewMode) => void;
}

interface DateGroup {
  date: string;
  entries: LayoutSummary[];
}

interface SourceGroup {
  source: EntrySource;
  dates: DateGroup[];
}

/** source → date → entries（日期倒序，新的在上；无效日期排最后） */
function groupBy(list: LayoutSummary[]): SourceGroup[] {
  const groups: SourceGroup[] = [];
  for (const e of list) {
    let g = groups.find((x) => x.source === e.source);
    if (!g) groups.push((g = { source: e.source, dates: [] }));
    const date = normalizeDate(e.fetchedAt);
    let d = g.dates.find((x) => x.date === date);
    if (!d) g.dates.push((d = { date, entries: [] }));
    d.entries.push(e);
  }
  for (const g of groups) {
    g.dates.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date < b.date ? 1 : -1;
    });
  }
  return groups;
}

function EntryCard({
  e,
  active,
  mode,
  onPick,
  onModeChange,
}: {
  e: LayoutSummary;
  active: boolean;
  mode: ViewMode;
  onPick: (id: string) => void;
  onModeChange: (id: string, mode: ViewMode) => void;
}) {
  const saved = e.source === 'saved';
  const tip =
    (saved ? `文件: ${e.file || e.id}` : e.url) + `\nviewport ${e.viewport[0]}x${e.viewport[1]}`;
  return (
    <div
      title={tip}
      onClick={() => onPick(e.id)}
      className={`mb-2 cursor-pointer rounded-[10px] border px-[13px] py-[11px] leading-[1.4] transition-colors ${
        active
          ? 'border-[#007aff] bg-[#eef4ff]'
          : 'border-[#e5e5ea] bg-white hover:border-[#d2d2d7]'
      }`}
    >
      <span className="mb-[7px] line-clamp-2 overflow-hidden text-[12.5px] leading-[1.45] font-semibold text-[#1d1d1f]">
        {e.title || '(无标题)'}
      </span>
      <div className="mt-1.5 flex items-center gap-[7px]">
        <span
          className={`inline-block max-w-[110px] truncate rounded-full px-2 text-[10.5px] leading-[18px] font-semibold ${
            saved ? 'bg-[#e5f6ec] text-[#0d7a45]' : 'bg-[#eef4ff] text-[#007aff]'
          }`}
        >
          {saved ? e.site || '本地' : '会话'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-[#86868b]">
          {e.fetchedAt}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-[7px]">
        <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-[#86868b]">
          {e.nodes} 节点
        </span>
        {/* 每张卡片独立维护 布局/MD 模式；阻断冒泡避免触发卡片选中 */}
        <span className="modes" onClick={(ev) => ev.stopPropagation()}>
          <Segmented
            size="small"
            value={mode}
            options={[
              { label: '布局', value: 'layout' },
              { label: 'MD', value: 'md' },
            ]}
            onChange={(v) => onModeChange(e.id, v as ViewMode)}
          />
        </span>
      </div>
    </div>
  );
}

/** Collapse 展开状态由组件内部维护（挂载时全部展开） */
export default function Sidebar({ list, currentId, viewModes, onPick, onModeChange }: SidebarProps) {
  return (
    <Layout.Sider
      width={276}
      theme="light"
      className="sticky top-0 h-screen border-r border-[#e5e5ea] text-xs [&>.ant-layout-sider-children]:flex [&>.ant-layout-sider-children]:h-full [&>.ant-layout-sider-children]:flex-col"
    >
      <div className="flex shrink-0 items-center gap-[9px] border-b border-[#e5e5ea] px-4 py-3.5 text-[13px] font-semibold text-[#1d1d1f]">
        <span className="relative h-[18px] w-[18px] shrink-0 rounded-[5px] bg-[#007aff] after:absolute after:inset-[4px_4px_7px] after:rounded-[2px] after:border-[1.5px] after:border-white/90 after:content-['']" />
        Boxtree 预览
        <span className="ml-auto text-[11px] font-normal tabular-nums text-[#86868b]">
          {list.length} 条
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-[18px] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-white [&::-webkit-scrollbar-thumb]:bg-[#e1e4ec] [&::-webkit-scrollbar]:w-2">
        {groupBy(list).map((g) => (
          <div key={g.source}>
            <div className="mx-0.5 mt-3.5 mb-1 text-[10.5px] font-medium tracking-[0.04em] text-[#86868b]">
              {g.source === 'saved' ? '本地落盘' : '本次会话'}
            </div>
            <Collapse
              ghost
              size="small"
              defaultActiveKey={g.dates.map(({ date }) => `${g.source}:${date}`)}
              className="[&_.ant-collapse-content-box]:px-0! [&_.ant-collapse-content-box]:pb-1! [&_.ant-collapse-header]:px-1!"
              items={g.dates.map(({ date, entries }) => {
                const k = `${g.source}:${date}`;
                return {
                  key: k,
                  label: (
                    <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#6e6e73]">
                      {dateLabel(date)}
                      <span className="font-normal tabular-nums text-[#86868b]">
                        {entries.length}
                      </span>
                    </span>
                  ),
                  children: entries.map((e) => (
                    <EntryCard
                      key={e.id}
                      e={e}
                      active={e.id === currentId}
                      mode={viewModes[e.id] ?? 'layout'}
                      onPick={onPick}
                      onModeChange={onModeChange}
                    />
                  )),
                };
              })}
            />
          </div>
        ))}
      </div>
    </Layout.Sider>
  );
}
