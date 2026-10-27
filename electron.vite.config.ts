import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(import.meta.dirname, 'src/shared')
// ARC_OUT_DIR lets parallel workers build without clobbering each other's out/.
const OUT = resolve(import.meta.dirname, process.env.ARC_OUT_DIR ?? 'out')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      // Keep runtime deps (electron-chrome-extensions) out of the bundle: the
      // library resolves its own preload file relative to node_modules and is
      // loaded lazily only when an extension is enabled.
      externalizeDeps: true,
      outDir: resolve(OUT, 'main'),
      target: 'node24',
      minify: true,
      sourcemap: false,
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      // Sandboxed preloads must be a single CommonJS file without requires
      // other than `electron`.
      outDir: resolve(OUT, 'preload'),
      externalizeDeps: false,
      isolatedEntries: true,
      minify: true,
      rollupOptions: {
        input: {
          shell: resolve(import.meta.dirname, 'src/preload/shell.ts'),
          page: resolve(import.meta.dirname, 'src/preload/page.ts'),
          // Not a preload: read as text by main and injected when an agent works in a tab.
          'agent-runtime': resolve(import.meta.dirname, 'src/preload/agent-runtime.ts'),
          'extension-compat': resolve(import.meta.dirname, 'src/preload/extension-compat.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: { alias: { '@shared': shared, '@': resolve(import.meta.dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(OUT, 'renderer'),
      target: 'chrome150',
      minify: true,
      cssMinify: true,
      modulePreload: { polyfill: false },
      reportCompressedSize: false,
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } }
    }
  }
})
