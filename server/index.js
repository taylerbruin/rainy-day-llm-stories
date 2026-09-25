// Rainy Day LLM Stories — local API gateway
//
// The single entry point for the local Node server. Responsibilities:
//   1. Open the SQLite database ONCE at startup (better-sqlite3 is
//      in-process and synchronous — keep one connection for the
//      server's lifetime; no pooling needed at this scale).
//   2. Assemble the Express app (routes, middleware).
//   3. Listen on :3000.
//
// Spring-mindset readers: this file is roughly
//   main() + application context assembly.
// There is no DI container — modules are just imported and shared.
//
// Run: `npm run dev`  (starts this + Vite via concurrently)
//      or `npm run start` for just the server.

import express from 'express';
import { openDb } from './db.js';
import worldsRouter from './routes/worlds.js';
import storyRouter from './routes/story.js';
import transcriptRouter from './routes/transcript.js';
import chaptersRouter from './routes/chapters.js';

const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
export const DEFAULT_MODEL = 'orcarouter/Qwen3.8-27B-128k';

// ── Database: open once, share everywhere ───────────────────────
// db.js applies PRAGMAs (WAL, foreign_keys=ON, busy_timeout) and the
// idempotent schema files. Everything below imports this same handle.
export const db = openDb();

const app = express();

// ── Middleware ──────────────────────────────────────────────────
// Express is deliberately bare: body parsing is opt-in.
app.use(express.json({ limit: '2mb' }));

// Tiny request log — the local equivalent of an access-log filter.
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(`[api] ${req.method} ${req.url} → ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  next();
});

// ── Routes ──────────────────────────────────────────────────────

// Health check (also handy to verify the DB is alive).
app.get('/api/health', (req, res) => {
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value;
  res.json({ status: 'ok', time: new Date().toISOString(), schema_version: version });
});

// ── Worlds controller ───────────────────────────────────────────
// Spring analog: a separate @Controller class with a class-level
// @RequestMapping("/api/worlds"). routes/worlds.js IS that class;
// the paths inside it ('/', '/:id') are relative to this prefix.
// Keeping index.js free of route bodies is what lets it stay the
// "main() + context assembly" file the comment at the top promises.
app.use('/api/worlds', worldsRouter);
app.use('/api', storyRouter); // POST /api/narrate, POST /api/choices
app.use('/api/chapters', chaptersRouter); // immutable history: POST /, GET /?worldId=N, GET /:id, PATCH /:id, DELETE /:id
app.use('/api/transcript', transcriptRouter); // the book: POST /, GET /?chapterId=N, GET /:id, DELETE /:id

// ── Errors & 404 (order matters: these catch everything above) ──
// Spring's @ExceptionHandler / HandlerExceptionResolver equivalent:
// any `throw` anywhere in a route lands here.
// Exported so route modules (routes/*.js) can throw the same shape.
export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 404 for unmatched paths (registered last so real routes win).
app.use((req, res) => {
  res.status(404).json({ error: `no route for ${req.method} ${req.url}` });
});

// Error handler — Express only routes to middleware with arity 4 (err, req, res, next).
// Important: once a STREAMING response has started (narrate/choices),
// bytes are already on the wire — the best we can do is end the
// stream early; writing a JSON error body after partial content
// would corrupt it.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[server]', err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: err.message || 'internal error' });
});

// ── Listen ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Rainy Day gateway listening on http://localhost:${PORT}`);
  console.log(`[server] Ollama proxy target: ${OLLAMA_URL} (model: ${DEFAULT_MODEL})`);
  console.log('[server] GET /api/health → { status: "ok", schema_version: ... }');
});
