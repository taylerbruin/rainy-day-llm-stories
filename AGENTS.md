# Agent instructions

## Stack
- Svelte 5 (runes) + TypeScript + Vite + Tailwind CSS v4 (`@tailwindcss/vite`, no `tailwind.config.js`).
- Svelte 5 rules: use `$state(...)` for reactive values and `on*` event **attributes** (e.g. `onclick={...}`) — NOT `on:*` event directives. Svelte-check flags both violations.
- `dexie` is available for local IndexedDB persistence.
- Run `npm run check` (svelte-check) after changes to validate.

## Local services (both must stay offline/local)
- **Ollama**: `http://localhost:11434`. Client: `src/lib/ollama.ts` → `streamChat()`. Model is fixed: `orcarouter/Qwen3.8-27B-128k` (see `DEFAULT_MODEL` in that file) — don't add a model selector.
- **ComfyUI** (FLUX.1-dev image gen): server on `localhost:8188`, but the app must call it through the **Vite dev proxy** — `COMFYUI_BASE = '/comfy'` in `src/lib/comfyui.ts`, proxied in `vite.config.ts`. Never call `:8188` directly from app code (CORS 403s).

## Gotchas
- The ComfyUI proxy in `vite.config.ts` uses `changeOrigin: false` on purpose: ComfyUI rejects requests where `Host` and `Origin` ports disagree. Do not "fix" it to `changeOrigin: true` — it will re-break image loading.
- Vite dev proxy config changes require a dev-server restart to take effect.
- First image generation is slow (~55s) while ~32 GB of models load into VRAM. Running Copilot + Ollama + ComfyUI simultaneously pressures VRAM on the RTX 5090.
