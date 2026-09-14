import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// JS·CSS를 index.html 한 장에 인라인합니다. Apps Script HtmlService 가 그대로 서빙합니다.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: { port: 5173, strictPort: true },   // OAuth 승인 출처와 포트를 고정합니다
  build: { target: 'es2018', assetsInlineLimit: 100000000, cssCodeSplit: false }
});
