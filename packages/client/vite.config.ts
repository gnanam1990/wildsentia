import { defineConfig } from 'vite';

// Where the live world runs. Override to point the observer at a second server.
const api = process.env.VANA_API_PORT ?? '8080';

export default defineConfig({
  build: { rollupOptions: { input: { forest: 'index.html', characters: 'characters.html', rewardsAdmin: 'rewards-admin.html',
    socialAdmin: 'social-admin.html', holder: 'holder.html', connect: 'connect.html',
    challenges: 'challenges.html', challengeNew: 'challenge-new.html' } } },
  server: {
    port: Number(process.env.VANA_CLIENT_PORT ?? 5173),
    proxy: {
      '/api': { target: `http://localhost:${api}`, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/live': { target: `ws://localhost:${api}`, ws: true },
    },
  },
});
