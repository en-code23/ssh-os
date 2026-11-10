import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Frontend for the Tauri app (the Rust backend lives in src-tauri/).
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: resolve(__dirname, 'out/renderer'), emptyOutDir: true, target: ['safari15', 'chrome105'] },
})
