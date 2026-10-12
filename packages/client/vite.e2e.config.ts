import base from './vite.config.js';
// Dev server against the local E2E stack's Caddy (tools/e2e/stack.sh), for debugging with __vana.
export default { ...base, server: { port: 5299, proxy: {
  '/api': { target: 'http://localhost:28080', changeOrigin: true },
  '/live': { target: 'ws://localhost:28080', ws: true },
} } };
