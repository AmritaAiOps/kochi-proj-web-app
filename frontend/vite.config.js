import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// No API proxy: the backend runs in the browser (src/py.worker.js) and shared
// state lives in Cloudflare Pages Functions (functions/) -- use `npm run dev`
// from the repo root (wrangler pages dev) to get both locally.
export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
})
