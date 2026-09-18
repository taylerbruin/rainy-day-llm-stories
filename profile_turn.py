#!/usr/bin/env python3
"""Turn profiler for Rainy Day LLM Stories.

Replicates one full in-app "turn" against the local services and times each
step, with the story context pushed as close to the model's 128k window as we
comfortably can:

    1. draft_reply   - narrator reply to the user's action
    2. draft_options - 4 possible next actions
    3. new_characters- detect newly-introduced characters, then profile each
    4. image_moment  - decide if this is an image moment; if yes, generate via
                       ComfyUI (FLUX.1-dev)

Run modes:
    best  - steered so NO new characters appear and NO image is wanted
    worst - steered so the reply INTRODUCES new characters AND an image is
            generated (the full step set, incl. ComfyUI)
    auto  - nothing steered; the model decides (default)

Results are printed as a table, appended to profile_results.jsonl (one JSON
object per run), and plotted into profile_report.png when matplotlib is
installed.

Usage:
    python profile_turn.py                 # auto mode, 1 run
    python profile_turn.py best worst      # best-case then worst-case
    python profile_turn.py worst --runs 3
    python profile_turn.py --dry-run       # check services + report context size
    python profile_turn.py --no-prewarm    # skip the warm-up calls (colder cache)
    python profile_turn.py worst --no-image --backend llamacpp   # A/B vs llama.cpp

Keep VS Code (and its Copilot process) closed while profiling for clean
numbers — the Qwen 27B model shares the RTX 5090's VRAM with everything else.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Service configuration (mirrors src/lib/ollama.ts + src/lib/comfyui.ts)
# ---------------------------------------------------------------------------

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://localhost:8188")

# Where the ComfyUI launch script lives, so the profiler can start it for you
# if it isn't running. Override with the COMFYUI_RUN_BAT env var if it's
# somewhere else (set to "" to disable auto-start).
COMFYUI_RUN_BAT = os.environ.get(
    "COMFYUI_RUN_BAT",
    r"F:\ComfyUI\ComfyUI_windows_portable\run_nvidia_gpu.bat",
)

MODEL = "orcarouter/Qwen3.8-27B-128k"
CONTEXT_LIMIT = 131_072  # tokens, matches CONTEXT_LIMIT in story.svelte.ts

# Which local LLM backend to profile: "ollama" (default) or "llamacpp"
# (a local llama-server speaking the OpenAI-compatible API). Both load the
# SAME GGUF weights, so an A/B compares the serving layer, not the model.
BACKEND: str = os.environ.get("LLM_BACKEND", "ollama").lower()
LLAMA_URL = os.environ.get("LLAMA_URL", "http://localhost:8080")
LLAMA_MODEL = os.environ.get("LLAMA_MODEL", "qwen3.8-27b")

# ~4 characters per token — the same heuristic the app's context meter uses.
CHARS_PER_TOKEN = 4
# Reserve this much of the context window for system prompts, the user action
# and model output so the filler never pushes us off the cliff edge.
RESERVED_TOKENS = 8_000

RESULTS_PATH = Path(__file__).with_name("profile_results.jsonl")
CHART_PATH = Path(__file__).with_name("profile_report.png")

REQUEST_TIMEOUT = 900  # generous: 27B over a 100k-token prompt can be slow

# Qwen3.8 is a reasoning model. Setting this to False (via --no-think) skips the
# private "thinking" pass, which is a real time sink - the model spends a good
# chunk of each step deliberating before it ever emits the answer.
THINK: bool = True


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def http_post_json(url: str, payload: dict, timeout: int = REQUEST_TIMEOUT):
    """POST JSON, return (status, parsed-or-text body)."""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.status, _decode_body(res)


def http_get(url: str, timeout: int = 30):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.status, _decode_body(res)


def _decode_body(res):
    raw = res.read()
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return text


# ---------------------------------------------------------------------------
# Ollama
# ---------------------------------------------------------------------------

@dataclass
class ChatResult:
    content: str = ""
    elapsed: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0


def chat(
    messages: list[dict],
    max_tokens: int = 500,
    temperature: float = 0.7,
    stream: bool = False,
) -> ChatResult:
    """Single chat call with timing + token usage.

    When ``stream`` is true, tokens are printed to the console as they arrive so
    you can *feel* the generation speed. The Qwen3.8 reasoning pass is skipped
    whenever the module-level ``THINK`` flag is False (set via --no-think).
    """
    if BACKEND == "llamacpp":
        return _llama_chat(messages, max_tokens=max_tokens, temperature=temperature, stream=stream)
    if stream:
        return _chat_stream(messages, max_tokens=max_tokens, temperature=temperature)
    payload = {
        "model": MODEL,
        "stream": False,
        "temperature": temperature,
        "options": {"num_predict": max_tokens},
        "messages": messages,
    }
    if not THINK:
        payload["think"] = False
    started = time.perf_counter()
    status, body = http_post_json(f"{OLLAMA_URL}/api/chat", payload)
    elapsed = time.perf_counter() - started

    content = ""
    if isinstance(body, dict):
        content = body.get("message", {}).get("content", "") or ""
    return ChatResult(
        content=content,
        elapsed=elapsed,
        prompt_tokens=int(body.get("prompt_eval_count", 0)) if isinstance(body, dict) else 0,
        completion_tokens=int(body.get("eval_count", 0)) if isinstance(body, dict) else 0,
    )


def _chat_stream(messages: list[dict], max_tokens: int = 500, temperature: float = 0.7) -> ChatResult:
    """Streaming variant of :func:`chat` — emits tokens to stdout as they arrive.

    Qwen3.8 is a reasoning model: early frames carry text in ``thinking`` and the
    real answer in ``content``. We stream BOTH so you see the full pace.
    """
    payload = {
        "model": MODEL,
        "stream": True,
        "temperature": temperature,
        "options": {"num_predict": max_tokens},
        "messages": messages,
    }
    if not THINK:
        payload["think"] = False
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    parts: list[str] = []
    prompt_tokens = 0
    completion_tokens = 0
    in_thinking = False
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as res:
        for raw in res:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            msg = obj.get("message", {})
            think_chunk = msg.get("thinking", "")
            if think_chunk:
                if not in_thinking:
                    print("  \u27e8thinking\u2026 \u27e9", end="", flush=True)
                    in_thinking = True
                print(think_chunk, end="", flush=True)
            content_chunk = msg.get("content", "")
            if content_chunk:
                if in_thinking:
                    print(" \u27e9", end="", flush=True)
                    in_thinking = False
                parts.append(content_chunk)
                print(content_chunk, end="", flush=True)
            if obj.get("done"):
                prompt_tokens = int(obj.get("prompt_eval_count", 0))
                completion_tokens = int(obj.get("eval_count", 0))
    if parts:
        print(flush=True)  # terminate the streamed line
    return ChatResult(
        content="".join(parts),
        elapsed=time.perf_counter() - started,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


# ---------------------------------------------------------------------------
# llama.cpp (llama-server, OpenAI-compatible)
# ---------------------------------------------------------------------------

def _llama_chat(
    messages: list[dict],
    max_tokens: int = 500,
    temperature: float = 0.7,
    stream: bool = False,
) -> ChatResult:
    """Talk to a local llama-server via the OpenAI-compatible chat API.

    Sampling params are top-level (``max_tokens``), not under ``options``.
    The Qwen3.8 reasoning pass is skipped (when THINK is False) via
    ``chat_template_kwargs.enable_thinking`` — the llama.cpp analogue of
    Ollama's ``think: false``.
    """
    url = f"{LLAMA_URL}/v1/chat/completions"
    payload: dict = {
        "model": LLAMA_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
    }
    if not THINK:
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    if stream:
        payload["stream_options"] = {"include_usage": True}
        return _llama_stream(url, payload)

    started = time.perf_counter()
    status, body = http_post_json(url, payload)
    elapsed = time.perf_counter() - started
    content = ""
    prompt_tokens = 0
    completion_tokens = 0
    if isinstance(body, dict):
        choices = body.get("choices") or []
        if choices:
            content = choices[0].get("message", {}).get("content", "") or ""
        usage = body.get("usage") or {}
        prompt_tokens = int(usage.get("prompt_tokens", 0))
        completion_tokens = int(usage.get("completion_tokens", 0))
    return ChatResult(
        content=content,
        elapsed=elapsed,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


def _llama_stream(url: str, payload: dict) -> ChatResult:
    """SSE streaming against llama-server. Emits tokens to stdout as they arrive.

    Deltas arrive as ``choices[0].delta.content``; some builds put the
    reasoning trace in ``delta.reasoning_content`` — we stream that too.
    ``usage`` (prompt/completion tokens) arrives in the final chunk when
    ``stream_options.include_usage`` is set.
    """
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    parts: list[str] = []
    prompt_tokens = 0
    completion_tokens = 0
    in_thinking = False
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as res:
        for raw in res:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if data == "[DONE]":
                continue
            try:
                obj = json.loads(data)
            except (json.JSONDecodeError, ValueError):
                continue
            usage = obj.get("usage")
            if isinstance(usage, dict):
                prompt_tokens = int(usage.get("prompt_tokens", prompt_tokens))
                completion_tokens = int(usage.get("completion_tokens", completion_tokens))
            choices = obj.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta", {}) or {}
            think_chunk = delta.get("reasoning_content") or delta.get("thinking") or ""
            if think_chunk:
                if not in_thinking:
                    print("  \u27e8thinking\u2026 \u27e9", end="", flush=True)
                    in_thinking = True
                print(think_chunk, end="", flush=True)
            content_chunk = delta.get("content") or ""
            if content_chunk:
                if in_thinking:
                    print(" \u27e9", end="", flush=True)
                    in_thinking = False
                parts.append(content_chunk)
                print(content_chunk, end="", flush=True)
    if parts:
        print(flush=True)
    return ChatResult(
        content="".join(parts),
        elapsed=time.perf_counter() - started,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN)


# ---------------------------------------------------------------------------
# Story context — push close to the 128k window without breaking it
# ---------------------------------------------------------------------------

BASE_SYSTEM_PROMPT = (
    "You are a second-person interactive story narrator in a rainy, moody, "
    "near-future city. Keep replies to 1-3 short paragraphs, vivid but brisk, "
    "in present tense, and always end by making the player's position in the "
    "scene concrete. Never use markdown."
)

_FILLER_ACTIONS = [
    "I keep walking.",
    "I take the side door.",
    "I wait by the window and watch the rain.",
    "I check my phone - no signal, of course.",
    "I pocket the note and go back inside.",
    "I nod and let them talk.",
    "I follow the smell of coffee.",
    "I duck into the archway to stay dry.",
    "I ask the stranger what they mean.",
    "I step over the puddle and keep going.",
]

_FILLER_BEATS = [
    "The rain comes down in a thin silver sheet, turning the streetlights into long amber smears. Neon from the noodle bar above flickers once, twice, and holds. Somewhere under the awning a radio murmurs a song half a bar out of tune, and the steam off the soup kettles drifts out into the cold and hangs there like something nobody has bothered to clean up yet. The city feels slower tonight, the way a room feels after the last argument has gone quiet - full of the shapes of things that almost happened.",
    "A man in a waxed jacket stands under the sign with a lantern he never turns on, the way some people stand under umbrellas it has stopped raining for. Across the street the shutter of the shuttered bookshop rattles in a wind that does not seem to be anywhere else. Your reflection does a half-second double take in the wet glass, and for a moment there are two of you in the frame and neither of them looks surprised about it.",
    "The bakery on the corner is closed, but its window is not. Someone has left a single croissant on the sill under a coffee cup used as a weight, and it is the most generous and the most absurd thing you have seen all week. The cup is full. It was just poured. The croissant is not a metaphor; you have checked by looking at it twice.",
    "Two umbrellas are staked into the gutter like they have been waiting for someone to decide about the rest of the night. A delivery scooter passes with no rider and a light that does not blink in the order lights are supposed to blink in, and the rain on its little roof makes a sound like the sea in a shell except the shell is a scooter and the sea is a Tuesday. You are, in every measurable way, on time.",
    "The laundromat on the third floor of the car park is still open, which it never is, and one machine is running a single sock, the drum patient as a cat. The attendant - if it is an attendant - is reading something with the absolute concentration of a person who has never once been interrupted by weather. The sock completes a full rotation. It completes another. Outside, the rain writes the same word on the same window over and over, and never once bothers to spell it correctly.",
    "You pass the clock that is four minutes behind the one across the street, which is two minutes ahead, and they are both, in their separate ways, telling the truth. A cat crosses the alley on a line that is perfectly straight, as if it had measured it. The rain on the awning keeps a rhythm you could almost tap, if your hands were not in your pockets, and your hands are in your pockets, and the night is not, in any way you can prove, going anywhere.",
    "The convenience store light paints the whole intersection the color of a developing photograph. Inside, the magazine rack has survived the week, which is a small miracle with a barcode on it. A fan in the ceiling turns at a speed that suggests it has opinions. The rain outside does not. It simply arrives, leaves, and arrives again, keeping no diary, asking no permission, taking absolutely nothing for granted except that the glass is there.",
    "Down the block the fountain that has been dry since spring finally runs, and the water that comes out is cold enough to have an attitude about it. The pigeons have a meeting. The meeting has a consensus. The consensus is that the rain is, on balance, fine. You stand in it a moment longer than is necessary, which is to say you stand in it exactly as long as you need to, and the city does not object, and neither, as it happens, do you.",
]


def build_filler(target_chars: int) -> list[dict]:
    """Deterministic filler transcript padded to ~target characters.

    Mostly narrator (assistant) text with an occasional short user action,
    so the shape resembles a real in-app session.
    """
    msgs: list[dict] = []
    total = len(BASE_SYSTEM_PROMPT)  # not counted; messages only
    beat_i = 0
    action_i = 0
    while total < target_chars:
        if total > 400 and action_i % 10 == 0:
            text = _FILLER_ACTIONS[action_i % len(_FILLER_ACTIONS)]
            msgs.append({"role": "user", "content": text})
            total += len(text)
            action_i += 1
        else:
            text = _FILLER_BEATS[beat_i % len(_FILLER_BEATS)]
            beat_i += 1
            if total + len(text) > target_chars and total > 0:
                break
            msgs.append({"role": "assistant", "content": text})
            total += len(text)
    return msgs


def context_size_estimate(messages: list[dict]) -> int:
    return sum(estimate_tokens(m["content"]) for m in messages)


# ---------------------------------------------------------------------------
# Step 1 - draft reply
# ---------------------------------------------------------------------------

def step_draft_reply(messages: list[dict]) -> tuple[dict, str]:
    res = chat(messages, max_tokens=450, stream=True)
    record = {
        "step": "1_draft_reply",
        "ok": True,
        "elapsed_s": round(res.elapsed, 3),
        "prompt_tokens": res.prompt_tokens or context_size_estimate(messages),
        "completion_tokens": res.completion_tokens,
        "note": "",
    }
    return record, res.content


# ---------------------------------------------------------------------------
# Step 2 - draft 4 next actions
# ---------------------------------------------------------------------------

def step_draft_options(story: list[dict]) -> dict:
    # Shared-prefix: keep the SAME story as step 1 so Ollama reuses its KV
    # cache and only re-computes this appended task (not the whole story).
    messages = [
        *story,
        {
            "role": "user",
            "content": (
                "Given the story above, propose 4 DISTINCT possible next moves for "
                "the player. Spread them across different intents: some actions to "
                "DO, some lines to SAY, and possibly a surprising OTHER option. "
                "Each must be one sentence, concrete and in second person. Respond "
                'with ONLY a JSON array of objects, each of the form '
                '{"type":"do"|"say"|"other","text":"..."} - no commentary, no markdown.'
            ),
        },
    ]
    res = chat(messages, max_tokens=400, temperature=0.8)
    text = _strip_fences(res.content)
    options = _try_json(text)
    if not isinstance(options, list):
        options = re.findall(r'"text"\s*:\s*"([^"]+)"', res.content)
    record = {
        "step": "2_draft_options",
        "ok": True,
        "elapsed_s": round(res.elapsed, 3),
        "prompt_tokens": res.prompt_tokens or context_size_estimate(messages),
        "completion_tokens": res.completion_tokens,
        "options_count": len(options) if isinstance(options, list) else 0,
        "note": "",
    }
    return record


# ---------------------------------------------------------------------------
# Step 3 - detect new characters + profile them
# ---------------------------------------------------------------------------

def _try_json(text: str):
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    m = re.search(r"[\{\[]", text)
    if m:
        try:
            return json.loads(text[m.start():])
        except (json.JSONDecodeError, ValueError):
            pass
    return None


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text


def step_new_characters(story: list[dict], reply: str, mode: str) -> list[dict]:
    records: list[dict] = []

    # Shared-prefix: same story as step 1 (cache reuse) + the fresh reply,
    # with the "find new characters" instruction appended at the very end.
    detect_messages = [
        *story,
        {"role": "assistant", "content": reply},
        {
            "role": "user",
            "content": (
                "Look ONLY at the latest narrator reply (the last assistant message "
                "above). List any NEW characters introduced in it that did not exist "
                "before this reply. Respond with ONLY JSON: "
                '{"new_characters": ["name or brief description", ...]} '
                "- an empty array if there are none. No commentary."
            ),
        },
    ]
    if mode == "best":
        detect_messages.append(
            {
                "role": "user",
                "content": (
                    "This action deliberately does not bring in anyone new. If no new "
                    "characters appear, return an empty list."
                ),
            }
        )
    elif mode == "worst":
        detect_messages.append(
            {
                "role": "user",
                "content": (
                    "The latest reply introduced at least two brand-new characters. "
                    "List every one of them."
                ),
            }
        )
    else:
        detect_messages.append({"role": "user", "content": "Who is new here?"})

    det_res = chat(detect_messages, max_tokens=200, temperature=0.0)
    parsed = _try_json(det_res.content)
    new_chars = []
    if isinstance(parsed, dict):
        raw = parsed.get("new_characters")
        if isinstance(raw, list):
            new_chars = [str(x).strip() for x in raw if str(x).strip()]
    detect_record = {
        "step": "3a_detect_new_characters",
        "ok": True,
        "elapsed_s": round(det_res.elapsed, 3),
        "prompt_tokens": det_res.prompt_tokens or context_size_estimate(detect_messages),
        "completion_tokens": det_res.completion_tokens,
        "new_characters": new_chars,
        "note": "no new characters detected" if not new_chars else f"{len(new_chars)} new character(s)",
    }
    records.append(detect_record)
    if not new_chars:
        return records

    for name in new_chars[:4]:
        # Shared-prefix: story + reply are already cached; only this task is new.
        profile_messages = [
            *story,
            {"role": "assistant", "content": reply},
            {
                "role": "user",
                "content": (
                    f"Profile this newly introduced character: {name}. Write a compact "
                    "profile so the narrative can stay consistent. Respond with ONLY "
                    "JSON of the form "
                    '{"name":"...","role":"...","appearance":"...","voice":"...",'
                    '"motivations":"...","secrets":"...","first_seen":"..."}.'
                    " No commentary."
                ),
            },
        ]
        prof_res = chat(profile_messages, max_tokens=450, temperature=0.4)
        profile = _try_json(prof_res.content)
        records.append(
            {
                "step": "3b_profile_character",
                "ok": True,
                "elapsed_s": round(prof_res.elapsed, 3),
                "prompt_tokens": prof_res.prompt_tokens or context_size_estimate(profile_messages),
                "completion_tokens": prof_res.completion_tokens,
                "character": name,
                "profile_saved": profile is not None,
                "note": "profile JSON valid" if profile is not None else "profile was not valid JSON",
            }
        )
    return records


# ---------------------------------------------------------------------------
# Step 4 - image decision + ComfyUI generation
# ---------------------------------------------------------------------------

def step_image(story: list[dict], reply: str, mode: str, allow_image: bool) -> list[dict]:
    records: list[dict] = []
    if not allow_image:
        # No image allowed -> skip the whole "should I draw?" decision (and any
        # generation). Asking costs ~10s of LLM time we would otherwise not spend.
        return records
    # Shared-prefix: same story + reply as step 1/3 (cache reuse), task at the end.
    decide_messages = [
        *story,
        {"role": "assistant", "content": reply},
        {
            "role": "user",
            "content": (
                "Decide whether the latest story moment (the last assistant message "
                "above) deserves an illustration. Respond with ONLY JSON: "
                '{"wants_image": true|false, "prompt": "..."} where prompt is a '
                "vivid 1-2 sentence image prompt if wants_image is true, otherwise "
                "an empty string. No commentary."
            ),
        },
    ]
    if mode == "best":
        decide_messages.append(
            {"role": "user", "content": "This is a quiet, transitional beat. Do not want an image unless truly forced."}
        )
    elif mode == "worst":
        decide_messages.append(
            {"role": "user", "content": "This is a vivid, landmark moment. Want an image, and write the best prompt you can."}
        )
    else:
        decide_messages.append({"role": "user", "content": "Is this a good moment for an image?"})

    dec_res = chat(decide_messages, max_tokens=150, temperature=0.3)
    parsed = _try_json(dec_res.content)
    wants_image = bool(parsed.get("wants_image")) if isinstance(parsed, dict) else False
    prompt = (parsed.get("prompt") or "").strip() if isinstance(parsed, dict) else ""
    records.append(
        {
            "step": "4a_image_decision",
            "ok": True,
            "elapsed_s": round(dec_res.elapsed, 3),
            "prompt_tokens": dec_res.prompt_tokens or context_size_estimate(decide_messages),
            "completion_tokens": dec_res.completion_tokens,
            "wants_image": wants_image,
            "image_prompt": prompt,
            "note": "",
        }
    )
    if not wants_image:
        records[-1]["note"] = "no image needed"
        return records
    if not prompt:
        prompt = "A rain-soaked street at night, neon reflections, cinematic, moody"

    gen_started = time.perf_counter()
    try:
        prompt_id = comfy_queue(prompt)
        image = comfy_wait(prompt_id)
        elapsed = time.perf_counter() - gen_started
        out_path = comfy_download(image, CHART_PATH.parent / "profile_images")
        records.append(
            {
                "step": "4b_comfyui_generate",
                "ok": True,
                "elapsed_s": round(elapsed, 3),
                "image_file": str(out_path) if out_path else "",
                "note": "image generated via ComfyUI (FLUX.1-dev)",
            }
        )
    except Exception as err:  # noqa: BLE001 - keep the run alive
        records.append(
            {
                "step": "4b_comfyui_generate",
                "ok": False,
                "elapsed_s": round(time.perf_counter() - gen_started, 3),
                "note": f"ComfyUI error: {err}",
            }
        )
    return records


# ---- ComfyUI client (mirrors src/lib/comfyui.ts, talks to :8188 directly) ----

def _flux_workflow(prompt: str, width: int = 1024, height: int = 1024, steps: int = 20, seed: int | None = None):
    seed = seed if seed is not None else int(time.time() * 1000) % 10_000_000_000
    return {
        "10": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors", "weight_dtype": "default"}},
        "11": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp16.safetensors", "type": "flux"}},
        "12": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["11", 0]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["11", 0]}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed, "steps": steps, "cfg": 1.0,
                "sampler_name": "euler", "scheduler": "beta", "denoise": 1.0,
                "model": ["10", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0],
            },
        },
        "4": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["12", 0]}},
        "13": {"class_type": "SaveImage", "inputs": {"filename_prefix": "rainy_day_profile", "images": ["4", 0]}},
    }


def comfy_queue(prompt: str) -> str:
    status, body = http_post_json(
        f"{COMFYUI_URL}/prompt",
        {"prompt": _flux_workflow(prompt), "client_id": "profile-turn"},
        timeout=60,
    )
    if not isinstance(body, dict) or not body.get("prompt_id"):
        raise RuntimeError(f"ComfyUI did not return a prompt id: {body!r}")
    return body["prompt_id"]


def comfy_wait(prompt_id: str, timeout_s: int = 600) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            _, body = http_get(f"{COMFYUI_URL}/history/{prompt_id}")
        except (urllib.error.URLError, TimeoutError):
            time.sleep(1.0)
            continue
        entry = body.get(prompt_id) if isinstance(body, dict) else None
        if entry:
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI error: {status}")
            if status.get("completed"):
                for node in (entry.get("outputs") or {}).values():
                    images = node.get("images") if isinstance(node, dict) else None
                    if images:
                        return images[0]
                raise RuntimeError("ComfyUI finished but no image was saved")
        time.sleep(1.0)
    raise TimeoutError("Timed out waiting for ComfyUI")


def comfy_download(image: dict, out_dir: Path) -> Path | None:
    try:
        url = (
            f"{COMFYUI_URL}/view?filename={urllib.parse.quote(image['filename'])}"
            f"&subfolder={urllib.parse.quote(image.get('subfolder', ''))}"
            f"&type={urllib.parse.quote(image.get('type', 'output'))}"
        )
        with urllib.request.urlopen(url, timeout=60) as res:
            data = res.read()
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"profile_{int(time.time())}_{image['filename']}"
        path.write_bytes(data)
        return path
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# Turn runner
# ---------------------------------------------------------------------------

@dataclass
class TurnResult:
    mode: str
    timestamp: str
    model: str
    context_tokens_estimate: int
    steps: list[dict] = field(default_factory=list)
    total_elapsed_s: float = 0.0
    backend: str = "ollama"

    def step_times(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for s in self.steps:
            name = s["step"].split("_", 1)[1] if "_" in s["step"] else s["step"]
            key = name if s["ok"] else f"{name} (failed)"
            out[key] = out.get(key, 0.0) + s.get("elapsed_s", 0.0)
        return out


USER_ACTION = (
    "The door opens without a knock. A woman in a long oilskin coat stands in the "
    "rain, water running off the brim of her hat, and beside her a small boy in a "
    "yellow raincoat who is not holding her hand. She holds out a paper bag that is "
    "still warm. 'You're the one at the window,' she says. It is not a question."
)


def run_turn(mode: str, allow_image: bool, verbose: bool, target_chars: int) -> TurnResult:
    filler = build_filler(target_chars)
    story = [{"role": "system", "content": BASE_SYSTEM_PROMPT}, *filler, {"role": "user", "content": USER_ACTION}]

    est = context_size_estimate(story)
    result = TurnResult(
        mode=mode,
        timestamp=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        model=MODEL,
        context_tokens_estimate=est,
        backend=BACKEND,
    )
    print(f"\n=== Turn [{mode}] — context ≈ {est:,} est. tokens "
          f"({est / CONTEXT_LIMIT * 100:.1f}% of the 128k window) ===")
    total_start = time.perf_counter()

    def record(rec: dict):
        result.steps.append(rec)
        flag = "ok " if rec.get("ok", True) else "ERR"
        extra = rec.get("note") or ""
        print(f"  [{flag}] {rec['step']:<26} {rec.get('elapsed_s', 0):>9.2f}s  {extra}")

    # 1. draft reply (streams to the console so you can feel the speed)
    print("  -- step 1 · draft reply (streaming) --")
    rec, reply = step_draft_reply(story)
    record(rec)
    print(flush=True)

    # 2. draft 4 options
    record(step_draft_options(story))

    # 3. new characters?
    for rec in step_new_characters(story, reply, mode):
        record(rec)

    # 4. image moment?
    for rec in step_image(story, reply, mode, allow_image):
        record(rec)

    result.total_elapsed_s = round(time.perf_counter() - total_start, 3)
    print(f"  TOTAL {'':<26} {result.total_elapsed_s:>9.2f}s")
    return result


# ---------------------------------------------------------------------------
# Prewarm — model in VRAM + ComfyUI weights loaded before timing starts
# ---------------------------------------------------------------------------

def prewarm(allow_image: bool) -> None:
    backend_name = "Ollama" if BACKEND == "ollama" else "llama.cpp"
    print(f"Prewarming {backend_name} (first run loads the 27B into VRAM)…")
    t0 = time.perf_counter()
    chat(
        [
            {"role": "system", "content": "You are a terse assistant."},
            {"role": "user", "content": "Reply with the single word: ready."},
        ],
        max_tokens=10,
    )
    print(f"  {backend_name} warm call done in {time.perf_counter() - t0:.1f}s")

    if allow_image:
        try:
            status, _ = http_get(f"{COMFYUI_URL}/system_stats")
            print("  ComfyUI is up — queueing a small warm-up image…")
            t0 = time.perf_counter()
            prompt_id = comfy_queue("A single grey raindrop on a dark window, minimal")
            image = comfy_wait(prompt_id, timeout_s=600)
            comfy_download(image, Path("profile_images"))
            print(f"  ComfyUI warm image done in {time.perf_counter() - t0:.1f}s")
        except Exception as err:  # noqa: BLE001
            print(f"  ComfyUI prewarm skipped: {err}")


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def save_result(result: TurnResult) -> None:
    with RESULTS_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(asdict(result), ensure_ascii=False) + "\n")


def load_results() -> list[dict]:
    if not RESULTS_PATH.exists():
        return []
    out = []
    with RESULTS_PATH.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def print_summary(results: list[TurnResult]) -> None:
    print("\n" + "=" * 78)
    print("SUMMARY — total turn time and step breakdown (seconds)")
    print("=" * 78)
    header = f"{'run':<12}"
    step_names = ["1 draft reply", "2 draft options", "3a detect new chars",
                  "3b profile char", "4a image decision", "4b comfyui image"]
    for name in step_names:
        header += f"{name:>20}"
    header += f"{'TOTAL':>12}"
    print(header)
    print("-" * len(header))
    for r in results:
        times = r.step_times()
        row = f"{r.mode + '-' + r.timestamp[-9:]:<12}"
        for key in ["draft_reply", "draft_options", "detect_new_characters",
                    "profile_character", "image_decision", "comfyui_generate"]:
            row += f"{times.get(key, 0.0):>20.2f}"
        row += f"{r.total_elapsed_s:>12.2f}"
        print(row)
    print(f"\nArtifacts: results → {RESULTS_PATH.name}, chart → {CHART_PATH.name}")


def _series_key(r: dict) -> str:
    """Group runs by backend + mode (+ context size) so A/B lines stay separate."""
    return f"{r.get('backend', 'ollama')} · {r['mode']} · {r.get('context_tokens_estimate', 0):,} tok"


def make_chart() -> None:
    """Plot EVERY run (not just an average).

    Two panels:
      A) total turn time per run — one line per (backend, mode, context) series,
         x = run index within the series. This is the honest A/B view: you see
         each individual run, including cold vs warm.
      B) mean step breakdown per series (bars), so you can see *where* time goes.

    Older results that predate the `backend` field are treated as "ollama".
    """
    results = load_results()
    if not results:
        return
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib not installed — skipping chart (pip install matplotlib)")
        return

    from collections import defaultdict
    from matplotlib import cm

    # Keep file order (chronological), but group into series for the line plot.
    series: dict[str, list[dict]] = defaultdict(list)
    for r in results:
        series[_series_key(r)].append(r)

    labels = {
        "draft_reply": "1. draft reply",
        "draft_options": "2. draft options",
        "detect_new_characters": "3a. detect new chars",
        "profile_character": "3b. profile char",
        "image_decision": "4a. image decision",
        "comfyui_generate": "4b. comfyui image",
    }
    key_order = list(labels.keys())
    n_series = max(len(series), 1)
    colors = [cm.tab10(i % 10) for i in range(n_series)]

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 9),
                                   gridspec_kw={"height_ratios": [1.2, 1.0]})

    # ---- Panel A: one line per series, every run as a point ----
    for color, (name, runs) in zip(colors, series.items()):
        xs = list(range(len(runs)))
        ys = [max(r["total_elapsed_s"], 1e-3) for r in runs]
        ax1.plot(xs, ys, marker="o", linewidth=1.6, color=color, label=name)
        for xi, yi in zip(xs, ys):
            ax1.annotate(f"{yi:.1f}", (xi, yi), textcoords="offset points",
                         xytext=(0, 8), ha="center", fontsize=7, color=color)
    ax1.set_yscale("log")
    ax1.set_xlabel("run index within series (chronological)")
    ax1.set_ylabel("total turn time (s, log scale)")
    ax1.set_title("Rainy Day LLM Stories — total turn time per run (A/B by backend)")
    ax1.legend(fontsize=8, loc="upper left")
    ax1.grid(axis="y", which="both", alpha=0.3)

    # ---- Panel B: mean step breakdown per series ----
    per_series_steps: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for r in results:
        key = _series_key(r)
        for s in r.get("steps", []):
            name = s["step"].split("_", 1)[1] if "_" in s["step"] else s["step"]
            if s.get("ok", True):
                per_series_steps[key][name].append(s.get("elapsed_s", 0.0))

    present_keys = [k for k in key_order if any(k in per_series_steps[m] for m in per_series_steps)]
    all_series = list(per_series_steps.keys())
    x = range(len(present_keys))
    width = 0.8 / max(len(all_series), 1)
    for i, sname in enumerate(all_series):
        vals = []
        for k in present_keys:
            seq = per_series_steps[sname].get(k)
            vals.append(sum(seq) / len(seq) if seq else 0.0)
        ax2.bar([xi + (i - (len(all_series) - 1) / 2) * width for xi in x],
                [max(v, 1e-3) for v in vals], width=width, color=colors[i % len(colors)], label=sname)
    ax2.set_yscale("log")
    ax2.set_xticks(list(x))
    ax2.set_xticklabels([labels.get(k, k) for k in present_keys], rotation=20, ha="right")
    ax2.set_ylabel("mean step time (s, log scale)")
    ax2.set_title("Mean step breakdown per series")
    ax2.legend(fontsize=7, loc="upper right")
    ax2.grid(axis="y", which="both", alpha=0.3)

    fig.tight_layout()
    fig.savefig(CHART_PATH, dpi=130)
    print(f"Chart saved → {CHART_PATH}  ({len(results)} runs, {n_series} series)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def comfyui_up() -> bool:
    try:
        http_get(f"{COMFYUI_URL}/system_stats", timeout=5)
        return True
    except Exception:  # noqa: BLE001
        return False


def comfyui_start(bat: str, wait_s: int = 120) -> bool:
    """Launch ComfyUI from its run script and wait until it answers.

    The bat opens its own console window (so you can see ComfyUI's log);
    we just wait for the /system_stats endpoint to come up.
    """
    if not bat:
        return False
    if not Path(bat).is_file():
        print(f"  ComfyUI run script not found: {bat} (set COMFYUI_RUN_BAT to fix)")
        return False
    print(f"  ComfyUI is down — starting {bat}")
    subprocess.Popen(
        bat,
        cwd=str(Path(bat).parent),
        creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
    )
    for i in range(1, wait_s + 1):
        if comfyui_up():
            print(f"  ComfyUI is up (took ~{i}s)")
            return True
        time.sleep(1)
    print(f"  ComfyUI did not come up within {wait_s}s — check its console window")
    return False


def check_services(allow_image: bool, no_start: bool = False) -> bool:
    ok = True
    if BACKEND == "llamacpp":
        try:
            status, body = http_get(f"{LLAMA_URL}/v1/models", timeout=5)
            ids = [m.get("id") for m in body.get("data", [])] if isinstance(body, dict) else []
            print(f"llama.cpp: up at {LLAMA_URL}")
            if ids:
                print(f"  model(s) loaded: {ids}")
            else:
                print("  WARNING: no models listed")
        except Exception as err:  # noqa: BLE001
            print(f"llama.cpp: DOWN — {err}")
            ok = False
    else:
        try:
            status, body = http_get(f"{OLLAMA_URL}/api/tags")
            names = [m.get("name") for m in body.get("models", [])] if isinstance(body, dict) else []
            print(f"Ollama: up at {OLLAMA_URL}")
            # Ollama lists tagged names (e.g. "model:latest"); a request for the
            # untagged name resolves to :latest, so compare tag-stripped too.
            stripped = {n.split(":", 1)[0] for n in names}
            if MODEL in names or MODEL in stripped:
                print(f"  model present: {MODEL}")
            else:
                print(f"  WARNING: {MODEL} not in {names}")
        except Exception as err:  # noqa: BLE001
            print(f"Ollama: DOWN — {err}")
            ok = False
    if allow_image:
        if comfyui_up():
            print(f"ComfyUI: up at {COMFYUI_URL}")
        elif no_start:
            print("ComfyUI: DOWN — worst-case runs will record a 4b failure (auto-start skipped)")
        elif comfyui_start(COMFYUI_RUN_BAT):
            print(f"ComfyUI: up at {COMFYUI_URL} (auto-started)")
        else:
            print(f"ComfyUI: DOWN — worst-case runs will record a 4b failure")
    return ok


def main() -> int:
    global THINK, BACKEND
    parser = argparse.ArgumentParser(description="Profile one full story turn (best/worst/auto).")
    parser.add_argument("modes", nargs="?", choices=["best", "worst", "auto"],
                        default="auto", help="Run mode (default: auto)")
    parser.add_argument("--runs", type=int, default=1, help="Runs per mode (default 1)")
    parser.add_argument("--no-image", action="store_true", help="Skip ComfyUI generation entirely")
    parser.add_argument("--no-prewarm", action="store_true", help="Skip warm-up calls before timing")
    parser.add_argument("--verbose", action="store_true", help="Print a reply preview")
    parser.add_argument("--no-start", action="store_true",
                        help="Never auto-start ComfyUI (just report it as down)")
    parser.add_argument("--context", type=float, default=1.0,
                        help="Fraction of the 128k window to fill (0.0-1.0, default 1.0). "
                             "Lower = shorter context = faster, e.g. --context 0.25")
    parser.add_argument("--no-think", action="store_true",
                        help="Skip Qwen3.8's reasoning pass (faster; model answers straight away)")
    parser.add_argument("--backend", choices=["ollama", "llamacpp"], default=BACKEND,
                        help="Local LLM backend to profile (default: ollama). "
                             "llamacpp talks to a llama-server at LLAMA_URL.")
    parser.add_argument("--dry-run", action="store_true", help="Check services and report context size, then exit")
    args = parser.parse_args()

    THINK = not args.no_think
    BACKEND = args.backend
    modes = [args.modes] if args.modes else ["auto"]
    allow_image = not args.no_image
    if not 0.0 < args.context <= 1.0:
        print("--context must be > 0 and <= 1.0")
        return 1

    print("Rainy Day LLM Stories — turn profiler")
    if BACKEND == "llamacpp":
        print(f"Backend: llamacpp → {LLAMA_URL} (model '{LLAMA_MODEL}')")
    else:
        print(f"Backend: ollama → {OLLAMA_URL}")
    print(f"Model: {MODEL}")
    print(f"Reasoning pass: {'OFF (--no-think)' if not THINK else 'on (default)'}")
    # In a dry run we only report — we don't spawn a server just to check it.
    if not check_services(allow_image, no_start=args.no_start or args.dry_run):
        print(f"\nBackend ({BACKEND}) is not reachable — aborting (fix the service and re-run).")
        return 1

    # Reserve headroom for prompts + output, then scale down by --context.
    budget_tokens = max(int((CONTEXT_LIMIT - RESERVED_TOKENS) * args.context), 256)
    target_chars = budget_tokens * CHARS_PER_TOKEN
    filler = build_filler(target_chars)
    est = context_size_estimate([{"role": "system", "content": BASE_SYSTEM_PROMPT}, *filler])
    print(f"Context plan: filler ≈ {target_chars / 1000:.0f}k chars ≈ {est:,} tokens "
          f"({est / CONTEXT_LIMIT * 100:.1f}% of {CONTEXT_LIMIT:,})")

    if args.dry_run:
        print("Dry run complete.")
        return 0

    if not args.no_prewarm:
        prewarm(allow_image)

    results: list[TurnResult] = []
    for mode in modes:
        for i in range(args.runs):
            suffix = f" (run {i + 1}/{args.runs})" if args.runs > 1 else ""
            print(f"\n>>> mode={mode}{suffix}")
            result = run_turn(mode, allow_image, args.verbose, target_chars)
            save_result(result)
            results.append(result)

    print_summary(results)
    make_chart()
    return 0


if __name__ == "__main__":
    try:
        import urllib.parse  # noqa: F401 (used by comfy_download)
    except ImportError:
        pass
    sys.exit(main())
