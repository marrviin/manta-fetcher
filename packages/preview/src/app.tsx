import { useEffect, useRef, useState } from 'react';
import { ConfigProvider, Empty, Layout, Spin } from 'antd';
import type { LayoutDetail, LayoutSummary, ViewMode } from './types';
import Sidebar from './components/sidebar';
import LayoutCanvas from './components/layout-canvas';
import MarkdownView from './components/markdown-view';
import './index.css';

export default function App() {
  const [list, setList] = useState<LayoutSummary[] | null>(null);
  const [current, setCurrent] = useState<LayoutDetail | null>(null);
  // 每个条目独立维护 视图模式（缺省布局）
  const [viewModes, setViewModes] = useState<Record<string, ViewMode>>({});
  const pickSeq = useRef(0);

  const pick = async (id: string) => {
    // 快速连续切换时丢弃过期响应，防止慢请求把旧条目渲染上去
    const seq = ++pickSeq.current;
    const detail: LayoutDetail = await (
      await fetch('/api/layout/' + encodeURIComponent(id))
    ).json();
    if (seq !== pickSeq.current) return;
    history.replaceState(null, '', `/?id=${encodeURIComponent(id)}`);
    setCurrent(detail);
  };

  useEffect(() => {
    (async () => {
      const res: LayoutSummary[] = await (await fetch('/api/layouts')).json();
      setList(res);
      const want = new URLSearchParams(location.search).get('id');
      const id = res.some((e) => e.id === want) ? want : res[res.length - 1]?.id;
      if (id) await pick(id);
    })();
  }, []);

  const setMode = (id: string, mode: ViewMode) => setViewModes((m) => ({ ...m, [id]: mode }));
  const mode: ViewMode = current ? (viewModes[current.id] ?? 'layout') : 'layout';

  let main: React.ReactNode;
  if (current) {
    // 视图容器二选一，由渲染分支天然互斥
    main = mode === 'md' ? <MarkdownView entry={current} /> : <LayoutCanvas layout={current.layout} />;
  } else if (list === null) {
    main = (
      <div className="my-20">
        <Spin size="large" />
      </div>
    );
  } else {
    main = (
      <div className="my-20">
        <Empty description="暂无预览数据（本地落盘目录无 boxtree，且会话未注册布局）" />
      </div>
    );
  }

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#007aff',
          borderRadius: 8,
          fontFamily:
            "-apple-system, system-ui, 'SF Pro Text', 'PingFang SC', 'Helvetica Neue', sans-serif",
        },
      }}
    >
      <Layout className="h-screen bg-[#f5f5f7]">
        <Sidebar
          list={list ?? []}
          currentId={current?.id}
          viewModes={viewModes}
          onPick={pick}
          onModeChange={setMode}
        />
        <Layout.Content className="flex flex-col items-center overflow-auto px-8 pt-7 pb-12">
          {main}
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  );
}
