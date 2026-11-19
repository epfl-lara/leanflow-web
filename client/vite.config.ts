import importMetaUrlPlugin from '@codingame/esbuild-import-meta-url-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react-swc'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import svgr from 'vite-plugin-svgr'
import { leanClientCompatibility } from './build/lean-client-compat.mjs'
import { browserStorageCompatibility } from './build/browser-storage-compat.mjs'

const leanClientCompat = leanClientCompatibility()
const browserStorageCompat = browserStorageCompatibility()

// https://vitejs.dev/config/
export default defineConfig({
  optimizeDeps: {
    esbuildOptions: {
      // @ts-ignore           // TODO
      plugins: [
        importMetaUrlPlugin,
        leanClientCompat.esbuild,
        browserStorageCompat.esbuild,
      ],
    },
    // exclude: ["Projects"],
  },
  build: {
    // studio.mjs serves the client/dist output directory.
    outDir: 'dist',
  },
  plugins: [
    leanClientCompat.vite,
    browserStorageCompat.vite,
    react(),
    tailwindcss(),
    svgr({
      include: ['**/*.svg?react', '**/*.svg'],
      svgrOptions: {
        exportType: 'default',
        ref: true,
        svgo: false,
        titleProp: true,
      },
    }),
    nodePolyfills({
      overrides: {
        fs: 'memfs',
      },
    }),
    viteStaticCopy({
      targets: [
        {
          src: [
            '../node_modules/@leanprover/infoview/dist/*.{js,css,ttf}',
            '../node_modules/lean4monaco/dist/webview/webview.js',
          ],
          dest: 'infoview',
          // Lean's iframe requests these fixed paths without source directories.
          rename: { stripBase: true },
        },
        {
          src: ['../node_modules/@leanprover/infoview/dist/codicon.ttf'],
          dest: 'assets',
          rename: { stripBase: true },
        },
        ...['cmaps', 'standard_fonts', 'wasm', 'iccs'].map((directory) => ({
          src: [`../node_modules/pdfjs-dist/${directory}/*`],
          dest: `pdfjs/${directory}`,
          rename: { stripBase: true },
        })),
        {
          src: ['../node_modules/pdfjs-dist/LICENSE'],
          dest: 'pdfjs',
          rename: { stripBase: true },
        },
      ],
    }),
  ],
  publicDir: 'public',
  base: '/', // setting this to `/leanweb/` means the server is now accessible at `localhost:3000/leanweb`
  server: {
    host: '127.0.0.1',
    port: 3000,
    proxy: {
      '/websocket': {
        target: 'ws://localhost:8090',
        ws: true,
      },
      '/yjs-signaling': {
        target: 'ws://localhost:8090',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:8090',
      },
    },
    watch: {
      ignored: ['**/.lake/**', '**/build/**'],
    },
  },
  resolve: {
    alias: {},
  },
})
