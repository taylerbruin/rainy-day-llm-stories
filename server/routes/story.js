// /api/narrate + /api/choices — the streaming Ollama proxy.
//
// Spring analog: a @Controller with class-level @RequestMapping("/api")
// and two streaming @PostMapping methods — the equivalent of relaying
// a WebClient `bodyToFlux(String)` straight back to the client.
//
// Today the two endpoints are the SAME proxy: the semantic difference
// (narration vs. producing 3–5 options) lives in the prompt, which the
// client composes. Once the server starts assembling prompts from the
// DB (world state, cast, transcript), these will diverge into real
// "smart" routes.
//
// Wire format: we forward Ollama's own JSON lines VERBATIM as ndjson.
// Each line is a chunk like {"message":{"role":"assistant","content":"…"},…}.
// That means the existing frontend line-parser (src/lib/ollama.ts)
// works unchanged — rewiring is a URL swap, not a protocol swap.

import { Router } from 'express';
import { streamChat } from '../lib/ollama.js';
import { httpError } from '../index.js';

const router = Router();

function makeStreamHandler() {
  return async (req, res) => {
    const { messages, think } = req.body ?? {};

    // Validate BEFORE any bytes go out — once headers are flushed, the
    // error middleware can only end the stream, not change the status.
    // (Spring analog: @Valid @RequestBody failing before the handler writes.)
    if (!Array.isArray(messages) || messages.length === 0) {
      throw httpError(400, '`messages` must be a non-empty array of {role, content}');
    }

    // Commit the streaming response BEFORE the first model token, so
    // the client (and any proxy) knows not to buffer and to render
    // deltas as they arrive.
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    await streamChat({
      messages,
      // Default OFF: skip the ~9s reasoning pass. Callers can opt in
      // with { "think": true } for a slower, more deliberate answer.
      think: think === true,
      writeLine: (line) => {
        res.write(line + '\n');
      },
    });

    res.end();
  };
}

router.post('/narrate', makeStreamHandler());
router.post('/choices', makeStreamHandler());

export default router;
