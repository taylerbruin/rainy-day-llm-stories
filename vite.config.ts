import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  server: {
    port: 5173,
    // Proxy ComfyUI through the app's origin so the browser doesn't hit a
    // cross-origin 403 (ComfyUI doesn't send CORS headers by default).
    //
    // changeOrigin MUST be false: ComfyUI rejects a request when the Host and
    // Origin ports disagree ("non matching host and origin ... 403"). The
    // browser sends `Origin: http://localhost:5173` on the /prompt POST, so we
    // keep `Host: localhost:5173` too (changeOrigin:true would rewrite Host to
    // :8188 and trip the check).
    proxy: {
      '/comfy': {
        target: 'http://localhost:8188',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/comfy/, ''),
      },
    },
  },
});
