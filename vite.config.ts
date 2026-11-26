import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
export default defineConfig({
  plugins: [solid()],
  // The Solid plugin compiles solid-markdown's JSX export; prebundle its JS
  // dependencies so Vite can serve their CommonJS imports on a cold dev load.
  optimizeDeps: {
    include: ['remark-parse', 'remark-rehype', 'unified', 'vfile'].map(dependency => `solid-markdown > ${dependency}`),
  },
  build: { outDir: 'dist/client' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4317' } },
});
