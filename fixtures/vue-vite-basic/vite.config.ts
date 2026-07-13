import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { webSourceInspector } from 'web-source-inspector/vite';

export default defineConfig({
  plugins: [
    webSourceInspector({
      ui: {
        language: 'zh-CN',
        buttonPosition: 'bottom-right',
        singleShot: true
      }
    }),
    vue()
  ]
});
