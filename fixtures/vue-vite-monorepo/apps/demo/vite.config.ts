import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { webSourceInspector } from '@web-source-inspector/vite-plugin';

export default defineConfig({ plugins: [webSourceInspector(), vue()] });
