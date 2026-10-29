import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * dev 模式：/api 代理给 core 的 previewServer。
 * 先以固定端口启动 core 侧（MANTA_PREVIEW_PORT 决定监听端口）：
 *   MANTA_PREVIEW_PORT=7788 ./node_modules/.bin/tsx packages/mcp/src/cli.ts preview
 * 再跑 pnpm --filter @manta-fetcher/preview dev，Vite 默认代理到 127.0.0.1:7788。
 */
const target = `http://127.0.0.1:${process.env.MANTA_PREVIEW_PORT || 7788}`;

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
    },
  },
});
