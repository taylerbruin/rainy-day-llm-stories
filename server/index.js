// Rainy Day LLM Stories — local API gateway (STUB)
//
// This is a placeholder so `npm run dev` runs end-to-end before the real
// server is built. It exposes one health endpoint and will grow into the
// full gateway (SQLite ownership + Ollama/ComfyUI proxies) per notes/plan.md.
//
// Run: `npm run dev`  (starts this + Vite via concurrently)
//      or `npm run start` for just the server.

import http from 'node:http';

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', stub: true, time: new Date().toISOString() }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found (server stub)' }));
});

server.listen(PORT, () => {
  console.log(`[server] Rainy Day gateway stub listening on http://localhost:${PORT}`);
  console.log('[server] GET /api/health → { status: "ok", stub: true }');
});
