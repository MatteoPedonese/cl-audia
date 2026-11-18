import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // Electron ha un Chromium recente: niente codice di compatibilità per browser vecchi
  build: { outDir: 'dist', target: 'chrome130', reportCompressedSize: false },
})
