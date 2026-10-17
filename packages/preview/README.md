# @manta-fetcher/preview

Boxtree 预览前端（Vite + React + TS + antd）。由 core 的 `previewServer.ts` 托管构建产物（`dist/`）并供给 `/api` 数据：

- `GET /api/layouts` — 列表（本地落盘 boxtree + 会话注册条目）
- `GET /api/layout/:id` — 详情（layout + markdown 投影）

## 使用

```bash
# 生产路径：构建后由 core 的预览 server 直接托管
pnpm --filter @manta-fetcher/preview build

# 前端热更开发：固定端口启动 core 侧 server，再起 Vite（/api 代理过去）
MANTA_PREVIEW_PORT=7788 ./node_modules/.bin/tsx packages/mcp/src/cli.ts preview   # 终端 1
pnpm --filter @manta-fetcher/preview dev                                          # 终端 2 → http://localhost:5173
```

core 侧通过 `MANTA_PREVIEW_PORT` 环境变量固定监听端口（缺省随机端口）。
