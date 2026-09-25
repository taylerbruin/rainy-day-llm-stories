// lib/ollama.js — the Ollama client for the gateway.
//
// Spring analog: a shared @Service wrapping WebClient. One place
// knows Ollama's URL, the fixed model, and how the stream is parsed;
// route modules import this instead of touching fetch themselves.
//
// Constraints worth remembering (full detail in notes/performance.md):
//   - Qwen3.8-27B is a REASONING model: the stream emits
//     `message.thinking` chunks first, then `message.content`.
//     Sending `think: false` skips the reasoning pass (~9s/turn).
//   - The KV cache is PREFIX-based and persists across calls in the
//     Ollama process. Callers must keep an identical, append-only
//     story prefix across turns so new turns extend the cached
//     prefix for free. That's the caller's job — this module just
//     forwards, but it's why the routes pass `messages` through
//     untouched rather than re-serializing "nicely".

export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// Fixed by project policy (AGENTS.md) — no model selector.
export const DEFAULT_MODEL = 'orcarouter/Qwen3.8-27B-128k';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream a chat completion.
 *
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {boolean} [opts.think=false] — enable the reasoning pass.
 * @param {(line: string) => void} opts.writeLine — called with each raw
 *   Ollama JSON line as it arrives (routes forward it to the response).
 * @returns {Promise<object|null>} the final chunk (carries `done: true`
 *   plus eval stats: eval_count, eval_duration, ...).
 */
export async function streamChat({ messages, think = false, writeLine }) {
  if (typeof writeLine !== 'function') throw httpError(500, 'streamChat: writeLine is required');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw httpError(400, '`messages` must be a non-empty array of {role, content}');
  }

  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: DEFAULT_MODEL, stream: true, think, messages }),
      });
    } catch (err) {
      // Ollama not running / port refused → 502, with a useful hint.
      throw httpError(502, `Couldn't reach Ollama at ${OLLAMA_URL} — ${err.cause?.message || err.message}`);
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let detail = '';
      try {
        detail = JSON.parse(text)?.error || '';
      } catch {
        /* not JSON */
      }
      // Retry once on 5xx — same behavior as the old client-side code.
      if (res.status >= 500 && attempt === 0) {
        attempt += 1;
        await sleep(1200);
        continue;
      }
      throw httpError(res.status >= 500 ? 502 : 422, `Ollama responded ${res.status} — ${detail || 'no detail provided'}`);
    }

    let last = null;
    for await (const line of readLines(res)) {
      const obj = JSON.parse(line);
      last = obj;
      writeLine(line);
    }
    return last;
  }
}

// Turn a streaming response body into complete text lines.
// (Synchronous better-sqlite3 aside, this is the one genuinely
// async thing in the server — a for-await over a web ReadableStream.)
async function* readLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  const tail = buf.trim();
  if (tail) yield tail;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
