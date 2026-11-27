import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The React UI, built for the Tauri shell (src-tauri).
export default defineConfig({
  root: 'src/renderer',
  base: './',
  clearScreen: false,
  server: { port: 5199, strictPort: true },
  build: {
    outDir: resolve('out/tauri'),
    emptyOutDir: true,
    minify: true,
    reportCompressedSize: false,
    assetsInlineLimit: (file: string) => (file.includes('material-icon-theme') ? false : undefined)
  },
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react()]
})
