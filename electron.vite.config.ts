import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'electron/main/index.ts') },
      // Native modules load from node_modules at runtime; bundling one breaks its own require of its binary.
      rollupOptions: { external: ['sharp', 'better-sqlite3', 'sqlite-vec'] },
      outDir: 'out/main'
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload/index.ts') },
      outDir: 'out/preload'
    }
  },
  renderer: {
    root: 'src',
    plugins: [react()],
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: { index: resolve(__dirname, 'src/index.html'), launcher: resolve(__dirname, 'src/launcher.html') } }
    }
  }
})
