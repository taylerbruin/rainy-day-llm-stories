# Performance notes — turn timing (local LLM)

Findings from benchmarking `profile_turn.py` on this box
(RTX 5090 + Ollama `orcarouter/Qwen3.8-27B-128k` + ComfyUI FLUX.1-dev).
All numbers are `best`/`worst` mode, `--no-image`, real measured runs.

## TL;DR — the single most important fact

**Ollama's KV cache is prefix-based and persists across calls in the same
server process. Once the story prefix is "warm," regenerating a step is
fast no matter how big the story is. Cold prefill is the whole game.**

Measured: a **98k-token** story produced a step in **7.8s warm** — the same
speed as a **31k-token** story (~7s). So after first prefill, context size
almost doesn't matter. The **first turn after Ollama starts (or after a
long idle / a different prefix) is the only genuinely slow one.**

This is why the same command, run back-to-back, is 2–5× faster on runs 2+:
run 1 is cold (re-prefill the whole story), runs 2+ reuse the cached KV.

## What makes a step slow (ranked)

1. **Cold prefill of the story context** — the dominant, one-time cost.
   Scales with context size. Paid once, then nearly free while warm.
2. **The model's reasoning ("thinking") pass** — Qwen3.8 is a *reasoning*
   model; it emits a `thinking` stream before the real `content`. Skippable
   with `think: false` (`--no-think`). Measured ~9s/turn at 31k.
3. **Number of LLM calls in a turn** — each additional call that re-reads
   the story adds a full prefill *unless* it shares the warm prefix.
4. Context size *when cold* — smaller `--context` = cheaper first prefill.
5. ComfyUI image gen (~55s first image, model load into VRAM) — separate
   service, only in image steps.

## Fixes already applied (and why)

- **Shared-prefix message order** (`profile_turn.py`, steps 2/3/4):
  Every step now leads with the **identical** story prefix (system + filler +
  user action) and appends its task as a **user message at the end**.
  Ollama matches the KV cache from token #0, so steps 2+ now *inherit*
  step 1's cached prefix instead of re-prefilling the whole story.
  - Before: each step had its own `system` prompt → prefix mismatch → full
    re-prefill every step (steps were ~12–15s each even in one turn).
  - After: steps 2/3 dropped to ~3–6s **on the cold run too**.

- **`--no-think` flag** + `THINK` global: sets `payload["think"]=False`,
  skipping the reasoning pass. Faster; model answers "straight away."

- **`--no-image`** fully excludes ComfyUI (not started, not prewarmed) and
  skips the 4a "should I draw?" decision.

- **Streaming fixed**: the old streamer only read `message.content`, but
  Qwen3.8 puts its reasoning in `message.thinking`. `_chat_stream` now reads
  and prints both (thinking wrapped in `⟨…⟩`).

## Practical implications for the app

- **Warm-up is everything.** The first generation the user sees after
  Ollama has been idle (or is starting) will be the slow one. Every
  subsequent turn with a growing-but-unchanged story prefix should be fast.

- **Append, don't rewrite, the story.** As long as earlier turns' text stays
  the same at the front of the context, new turns extend the cached prefix
  for free. Reordering/summarizing/truncating history will break the prefix
  match and force a re-prefill.

- **Candidate feature ideas (not yet built):**
  - Hide/absorb the cold start: fire a small "prewarm" chat call on app load
    (already done in the profiler) so the first *user-visible* turn isn't the
    one that pays prefill. Consider a subtle "warming up…" state.
  - Keep a persistent, stable system prompt + history order so the KV prefix
    stays valid between turns and across app restarts (as long as Ollama
    stays up).
  - Consider dropping/merging cheap steps (options vs new-character detect)
    — with warm caching the benefit is small now; only worth it to cut call
    count.
  - If first-turn latency matters, a cheaper/faster model for the cold
    prefill or `--no-think` by default.

## Quick repro

```
# cold vs warm in one batch (note run 1 vs 2/3)
python profile_turn.py best  --no-image --context 0.25 --runs 3
python profile_turn.py worst --no-image --context 0.8  --runs 3

# skip the reasoning pass
python profile_turn.py best  --no-image --context 0.25 --no-think

# dry run: check services + show planned context size, no LLM calls
python profile_turn.py best  --no-image --context 0.25 --dry-run
```

## Known quirks

- `3b profile character` can return invalid JSON (seen once at 98k, 7.7s,
  "profile was not valid JSON"). The app should tolerate and retry, or
  loosen the profile contract.
- Run-to-run variance on the *cold* first step is large (VRAM contention
  with VS Code/Copilot sharing the RTX 5090). Close VS Code for the tightest
  cold-start numbers.
