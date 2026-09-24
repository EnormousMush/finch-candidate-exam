import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import 'dotenv/config';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    // 开发时前端通过代理访问后端，浏览器只和同源打交道，cookie 不跨域
    proxy: { '/api': `http://localhost:${process.env.PORT ?? 3000}` },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
