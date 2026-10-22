import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The CKB Explorer API has no CORS headers, so browser fetches are blocked. In dev we proxy
// it same-origin. A production build needs an equivalent proxy for token names (VITE_EXPLORER_PROXY).
const EXPLORER = process.env.VITE_NETWORK === 'mainnet'
  ? 'https://mainnet-api.explorer.nervos.org'
  : 'https://testnet-api.explorer.nervos.org'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/__explorer': {
        target: EXPLORER,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__explorer/, ''),
      },
    },
  },
  // CCC and some deps use node-style globals; this keeps them happy in the browser
  define: { 'process.env': {} },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  build: { target: 'es2022' },
})
