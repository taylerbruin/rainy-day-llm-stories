<script lang="ts">
	import { onMount } from 'svelte';

	type Role = 'user' | 'assistant';

	interface Message {
		id: number;
		role: Role;
		content: string;
	}

	let idCounter = 0;

	let messages: Message[] = $state([
		{
			id: idCounter++,
			role: 'assistant',
			content: "Hey — I'm the story window, running on Ollama. Tell me something and I'll reply. ☔"
		}
	]);

	let scrollEl: HTMLElement | undefined = $state();
	let busy = $state(false);

	// Next-step options: the model proposes a small set of DISTINCT possible
	// next moves, each tagged by intent (Do / Say / Other). Only the most
	// recent slice of the conversation is sent as context to keep the prompt
	// (and token cost) small. Options are revealed one at a time so the list
	// feels like it streams in.
	type OptionType = 'do' | 'say' | 'other';
	interface StoryOption {
		id: number;
		type: OptionType;
		text: string;
	}

	const OPTION_CONTEXT_MESSAGES = 3;
	const OPTION_COUNT = 4;
	let storyOptions = $state<StoryOption[]>([]);
	let freeform = $state('');
	let error = $state<string | null>(null);
	let instruction = $state('');
	let instructionOpen = $state(false);

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const OLLAMA_URL = 'http://localhost:11434/api/chat';
	const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags';
	const DEFAULT_MODEL = 'orcarouter/Qwen3.8-27B-Uncensored';
	// Used only when the model doesn't report its own context length.
	const DEFAULT_CONTEXT = 4096;

	let models = $state<string[]>([]);
	let selectedModel = $state(DEFAULT_MODEL);
	let loadingModels = $state(false);

	// Context usage: real prompt tokens from Ollama when known, otherwise an
	// estimate. contextLimit is the model's max context window.
	let promptTokens = $state<number | null>(null);
	let contextLimit = $state(DEFAULT_CONTEXT);

	// Rough character-based estimate, used until a real token count is known.
	const estimatedTokens = $derived(
		messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
	);

	const usedTokens = $derived(promptTokens ?? estimatedTokens);
	const contextPct = $derived(Math.min(100, (usedTokens / contextLimit) * 100));

	// The first story paragraph gets a drop cap.
	const firstStoryId = $derived(messages.find((m) => m.role === 'assistant')?.id);
	const DROP_CAP =
		'first-letter:float-left first-letter:mr-2 first-letter:mt-0.5 first-letter:inline-block first-letter:text-5xl first-letter:leading-[0.85] first-letter:font-serif';

	// Always include the current selection as an option, even before the
	// model list has loaded or if it isn't installed locally.
	const options = $derived.by(() => {
		const list = [...models];
		if (selectedModel && !list.includes(selectedModel)) {
			list.unshift(selectedModel);
		}
		return list;
	});

	function nextId(): number {
		return idCounter++;
	}

	// Known context window per model, from /api/tags (when provided).
	const contextLengths = new Map<string, number>();

	async function loadModels(): Promise<void> {
		loadingModels = true;
		try {
			const res = await fetch(OLLAMA_TAGS_URL);
			if (!res.ok) {
				throw new Error(`Ollama responded with ${res.status}`);
			}
			const data: { models?: { name: string; context_length?: number }[] } = await res.json();
			const list = data.models ?? [];
			const names = list.map((m) => m.name);
			for (const m of list) {
				if (typeof m.context_length === 'number' && m.context_length > 0) {
					contextLengths.set(m.name, m.context_length);
				}
			}
			if (names.length) {
				models = names;
				// Fall back to the first installed model if the default isn't there.
				if (!names.includes(selectedModel)) {
					selectedModel = names[0];
				}
				contextLimit = contextLengths.get(selectedModel) ?? DEFAULT_CONTEXT;
			}
		} catch {
			models = [];
		} finally {
			loadingModels = false;
		}
	}

	// Switch the active model. A token count measured against a previous model
	// is no longer meaningful, so we discard it (estimation takes over until
	// the next reply reports a fresh prompt_eval_count).
	function changeModel(name: string): void {
		selectedModel = name;
		promptTokens = null;
		contextLimit = contextLengths.get(name) ?? DEFAULT_CONTEXT;
	}

	// Ask the model for a small set of distinct next moves, streaming the reply
	// so options appear one-by-one as they're generated. Only the most recent
	// slice of the conversation is sent as context. An optional `instruction`
	// (e.g. "kill the orc") steers what the options focus on.
	async function generateOptions(instruction?: string): Promise<void> {
		if (busy) return;

		busy = true;
		error = null;
		storyOptions = [];
		const steer = (instruction ?? '').trim();

		// Ollama wants the context to end on a user turn; after the narrator
		// adds a line the transcript can end on an assistant message, which
		// triggers "no user query found in messages".
		const recent = messages
			.slice(-OPTION_CONTEXT_MESSAGES)
			.map((m) => ({ role: m.role, content: m.content }));
		if (recent.length === 0 || recent[recent.length - 1].role !== 'user') {
			recent.push({ role: 'user', content: 'What happens next?' });
		}

		const steerLine = steer
			? 'The player wants to focus the options on this: "' + steer + '". Weave it into each option where it fits.\n'
			: '';

		const payload = {
			model: selectedModel,
			stream: true,
			messages: [
				{
					role: 'system',
					content:
						'You are a reflective story narrator. Given the story so far, propose ' +
						OPTION_COUNT +
						' DISTINCT possible next moves for the player. Spread them across different ' +
						'intents: some actions to DO, some lines to SAY, and possibly a surprising OTHER ' +
						'option. Each must be one sentence, concrete and in second person. ' +
						steerLine +
						'Respond with ONLY a JSON array of objects, each of the form ' +
						'{"type":"do"|"say"|"other","text":"..."} — no commentary, no markdown.'
				},
				...recent
			]
		};

		let raw = '';
		let scanIndex = 0;
		let emitted = 0;

		const reveal = (objJson: string) => {
			if (emitted++ >= OPTION_COUNT) return;
			try {
				const option = itemToOption(JSON.parse(objJson));
				if (option) storyOptions = [...storyOptions, option];
			} catch {
				/* skip a malformed fragment */
			}
		};

		try {
			await streamChat(payload, (delta) => {
				raw += delta;
				const { objects, nextStart } = extractObjects(raw, scanIndex);
				for (const obj of objects) reveal(obj);
				scanIndex = nextStart;
			});

			// Fallback: the model returned something that isn't a stream of
			// objects (e.g. plain strings or a line list) — parse the whole thing.
			if (storyOptions.length === 0) {
				for (const option of parseOptions(raw.trim())) {
					storyOptions = [...storyOptions, option];
				}
			}
		} catch (err) {
			storyOptions = [];
			error = err instanceof Error ? err.message : 'Something went wrong';
		} finally {
			busy = false;
		}
	}

	// Turn a single parsed JSON item into a typed option, or null if unusable.
	function itemToOption(item: unknown): StoryOption | null {
		if (typeof item === 'string') {
			const clean = item.trim();
			return clean ? { id: nextId(), type: guessType(clean), text: clean } : null;
		}
		if (item && typeof item === 'object') {
			const o = item as Record<string, unknown>;
			const type =
				o.type === 'do' || o.type === 'say' || o.type === 'other' ? (o.type as OptionType) : undefined;
			const text = String(o.text ?? o.content ?? o.option ?? '').trim();
			return text ? { id: nextId(), type: type ?? guessType(text), text } : null;
		}
		return null;
	}

	// Scan `raw` from `start` for complete, balanced JSON objects, stopping at
	// the first incomplete one. Returns them plus where to resume scanning.
	function extractObjects(raw: string, start: number): { objects: string[]; nextStart: number } {
		const objects: string[] = [];
		let i = start;
		while (i < raw.length) {
			while (i < raw.length && raw[i] !== '{') i++;
			if (i >= raw.length) return { objects, nextStart: i };
			let depth = 0;
			let inStr = false;
			let esc = false;
			let j = i;
			for (; j < raw.length; j++) {
				const c = raw[j];
				if (inStr) {
					if (esc) esc = false;
					else if (c === '\\') esc = true;
					else if (c === '"') inStr = false;
				} else if (c === '"') inStr = true;
				else if (c === '{') depth++;
				else if (c === '}') {
					depth--;
					if (depth === 0) break;
				}
			}
			if (depth !== 0 || inStr) return { objects, nextStart: i };
			objects.push(raw.slice(i, j + 1));
			i = j + 1;
		}
		return { objects, nextStart: i };
	}

	// Stream a chat request, calling onDelta with each content chunk as it
	// arrives. Surfaces the server's own error body; retries once on 5xx.
	async function streamChat(payload: object, onDelta: (delta: string) => void): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			let res: Response;
			try {
				res = await fetch(OLLAMA_URL, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload)
				});
			} catch (err) {
				throw new Error(`Couldn't reach Ollama — ${err instanceof Error ? err.message : 'connection failed'}`);
			}

			if (!res.ok || !res.body) {
				const text = await res.text().catch(() => '');
				let detail = text;
				try {
					const body = JSON.parse(text);
					if (body?.error) detail = body.error;
				} catch {
					/* not JSON */
				}
				if (res.status >= 500 && attempt === 0) {
					await sleep(1200);
					continue;
				}
				throw new Error(`Ollama responded with ${res.status} — ${detail || 'no detail provided'}`);
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf('\n')) !== -1) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					try {
						const parsed = JSON.parse(line);
						const delta = parsed?.message?.content;
						if (typeof delta === 'string') onDelta(delta);
					} catch {
						/* ignore partial / keep-alive lines */
					}
				}
			}
			return;
		}
	}

	// Turn the model's reply into typed options. Handles a clean JSON array of
	// {type,text} objects, a JSON array of plain strings, or a line-broken list.
	function parseOptions(raw: string): StoryOption[] {
		if (!raw) return [];

		const toOption = (type: OptionType | undefined, text: string): StoryOption | null => {
			const clean = text.trim();
			if (!clean) return null;
			return { id: nextId(), type: type ?? guessType(clean), text: clean };
		};

		const jsonMatch = raw.match(/\[[\s\S]*\]/);
		if (jsonMatch) {
			try {
				const parsed: unknown = JSON.parse(jsonMatch[0]);
				if (Array.isArray(parsed)) {
					const items = parsed
						.map((item) => {
							if (typeof item === 'string') return toOption(undefined, item);
							if (item && typeof item === 'object') {
								const o = item as Record<string, unknown>;
								const type =
									o.type === 'do' || o.type === 'say' || o.type === 'other'
										? (o.type as OptionType)
										: undefined;
								return toOption(type, String(o.text ?? o.content ?? o.option ?? ''));
							}
							return null;
						})
						.filter((x): x is StoryOption => x !== null);
					if (items.length) return items.slice(0, OPTION_COUNT);
				}
			} catch {
				/* fall through to line parsing */
			}
		}

		return raw
			.split(/\r?\n/)
			.map((line) => line.replace(/^\s*(\d+[.)]|-|\*)\s*/, '').trim())
			.filter(Boolean)
			.slice(0, OPTION_COUNT)
			.map((text) => ({ id: nextId(), type: guessType(text) as OptionType, text }));
	}

	// Crude heuristic for tagging an option when the model didn't label it.
	function guessType(text: string): OptionType {
		if (/^(say|tell|reply|whisper|call|ask|shout|speak|answer)/i.test(text)) return 'say';
		if (/^(run|hit|take|grab|open|close|climb|hide|attack|throw|pull|pick|turn|leave|cut|break|point|aim)/i.test(text)) {
			return 'do';
		}
		return 'other';
	}

	// Append a chosen next line to the story and reset the panel.
	function addStoryLine(text: string): void {
		const clean = text.trim();
		if (!clean || busy) return;
		messages = [...messages, { id: nextId(), role: 'assistant', content: clean }];
		storyOptions = [];
		freeform = '';
		error = null;
	}

	function onKeyDown(e: KeyboardEvent): void {
		// Enter adds the line, Shift+Enter inserts a newline.
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			addStoryLine(freeform);
		}
	}

	function scrollToBottom(): void {
		if (scrollEl) {
			scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
		}
	}

	$effect(() => {
		// Keep the newest message in view whenever the list changes.
		scrollToBottom();
	});

	onMount(() => {
		loadModels();
	});
</script>

<section
	aria-label="Story book"
	class="flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[#2b2f3a] bg-[#151821] shadow-2xl shadow-black/50"
>
	<header class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#2b2f3a] px-6 py-4">
		<div class="min-w-0 leading-tight">
			<h2 class="font-serif text-lg font-semibold tracking-wide text-[#ece7db]">
				Rainy Day Stories
			</h2>
			<p class="text-xs italic text-[#8a90a0]">
				{loadingModels ? 'Gathering the pages…' : 'Told to you by Ollama'}
			</p>
		</div>

		<div class="ml-auto flex items-center gap-4">
			<label class="flex items-center gap-2 text-xs text-[#8a90a0]">
				<span class="hidden sm:inline">Narrator</span>
				<select
					bind:value={selectedModel}
					onchange={() => changeModel(selectedModel)}
					disabled={loadingModels || busy}
					aria-label="Select story model"
					class="max-w-[220px] rounded-md border border-[#333744] bg-[#0e1016] px-2.5 py-1.5 text-xs text-[#d9dce4] focus:border-[#c9922b] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/30 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{#if loadingModels}
						<option value={DEFAULT_MODEL} disabled>
							Loading…
						</option>
					{:else}
						{#each options as model (model)}
							<option value={model}>{model}</option>
						{/each}
					{/if}
				</select>
			</label>

			<div
				class="flex items-center gap-2"
				title={`${usedTokens} / ${contextLimit} tokens used — how much of the story is remembered`}
			>
				<span class="text-[10px] uppercase tracking-wide text-[#8a90a0]">Pages</span>
				<div class="h-2 w-24 overflow-hidden rounded-full bg-[#232733]">
					<div
						class="h-full rounded-full transition-all duration-300 {contextPct >= 85 ? 'bg-[#e0685c]' : contextPct >= 60 ? 'bg-[#d9a441]' : 'bg-[#8aa05f]'}"
						style={`width: ${contextPct}%`}
					></div>
				</div>
				<span class="text-xs tabular-nums text-[#8a90a0]">{contextPct.toFixed(0)}%</span>
			</div>
		</div>
	</header>

	<div
		bind:this={scrollEl}
		class="flex-1 overflow-y-auto px-7 py-6"
	>
		<div class="mx-auto max-w-prose">
			{#each messages as message (message.id)}
				{#if message.role === 'assistant'}
					<p
						class="whitespace-pre-wrap font-serif text-[17px] leading-[1.85] text-[#e3ddcf] {message.id === firstStoryId ? DROP_CAP : 'mt-5'}"
					>
						{message.content}
					</p>
				{:else}
					<div class="my-5 border-l-2 border-[#3a3f4c] pl-4">
						<p class="font-serif text-sm italic leading-relaxed text-[#9aa0b0]">
							<span class="mr-2 not-italic text-[#c9922b]">✎</span>
							{message.content}
						</p>
					</div>
				{/if}
			{/each}

			{#if busy}
				<p class="mt-5 font-serif text-[17px] italic leading-[1.85] text-[#7d8496]">
					The narrator is weighing the next moment…
				</p>
			{/if}
		</div>
	</div>

	<footer class="border-t border-[#2b2f3a] px-7 py-4">
		<div class="mx-auto max-w-prose">
			<div class="flex items-center justify-between gap-3">
				<h3 class="font-serif text-sm font-semibold text-[#ece7db]">What do you do next?</h3>

				<div class="flex items-stretch overflow-hidden rounded-md border border-[#333744]">
					<button
						type="button"
						onclick={() => generateOptions()}
						disabled={busy}
						aria-label="Refresh options"
						title="Regenerate options from the recent story"
						class="flex w-11 items-center justify-center bg-[#0e1016] text-[#9aa0b0] transition hover:bg-[#171a22] hover:text-[#ece7db] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#c9922b]/40 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{#if busy}
							<span
								class="h-4 w-4 animate-spin rounded-full border-2 border-[#9aa0b0]/40 border-t-[#d9dce4]"
							></span>
						{:else}
							<span class="text-base leading-none">↻</span>
						{/if}
					</button>

					<div class="w-px bg-[#333744]"></div>

					<button
						type="button"
						onclick={() => (instructionOpen = !instructionOpen)}
						disabled={busy}
						aria-label="Steer the options"
						aria-expanded={instructionOpen}
						title="Add a focus for the options"
						class="flex w-11 items-center justify-center bg-[#0e1016] text-[#9aa0b0] transition hover:bg-[#171a22] hover:text-[#ece7db] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#c9922b]/40 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{#if instructionOpen}
							<span class="text-base leading-none">−</span>
						{:else}
							<span class="text-base leading-none">＋</span>
						{/if}
					</button>
				</div>
			</div>

			{#if instructionOpen && !busy}
				<div class="mt-3 flex items-end gap-2">
					<textarea
						bind:value={instruction}
						rows="1"
						placeholder="Steer the options — e.g. kill the orc"
						class="max-h-32 min-h-[44px] flex-1 resize-none rounded-md border border-[#333744] bg-[#0e1016] px-3.5 py-2.5 font-serif text-[14px] text-[#d9dce4] placeholder:italic placeholder:text-[#6b7280] focus:border-[#c9922b] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/30"
					></textarea>
					<button
						type="button"
						onclick={() => {
							generateOptions(instruction);
							instruction = '';
							instructionOpen = false;
						}}
						disabled={busy}
						class="flex h-[44px] items-center justify-center rounded-md bg-[#c9922b] px-4 font-serif text-sm font-semibold text-[#1a130a] transition hover:bg-[#b07f22] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/40 disabled:cursor-not-allowed disabled:opacity-40"
					>
						Generate
					</button>
				</div>
			{/if}

			{#if error}
				<div
					class="mt-3 flex items-start gap-2 rounded-md border border-[#5a2b2b] bg-[#2a1717] px-3.5 py-2.5 text-[13px] text-[#e0a9a0]"
					role="alert"
				>
					<span class="mt-0.5">⚠️</span>
					<span>{error}</span>
				</div>
			{/if}

			{#if storyOptions.length}
				<ul class="mt-3 space-y-2">
					{#each storyOptions as option (option.id)}
						<li
							class="flex items-center gap-3 rounded-md border border-[#2b2f3a] bg-[#0e1016] px-3.5 py-2.5 transition hover:border-[#c9922b] hover:bg-[#171a22]"
						>
							<p class="min-w-0 flex-1 font-serif text-[14px] leading-relaxed text-[#c9c3b4]">
								{option.text}
							</p>
							<button
								type="button"
								onclick={() => addStoryLine(option.text)}
								disabled={busy}
								class="shrink-0 rounded-md border border-[#333744] bg-[#0e1016] px-3 py-1.5 text-xs font-semibold text-[#d9dce4] transition hover:border-[#c9922b] hover:text-[#ece7db] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/40 disabled:cursor-not-allowed disabled:opacity-40"
							>
								Use
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			<div class="mt-3 flex items-end gap-2 border-t border-[#232733] pt-3">
				<textarea
					bind:value={freeform}
					onkeydown={onKeyDown}
					rows="2"
					placeholder="…or write your own next move"
					class="max-h-40 min-h-[44px] flex-1 resize-none rounded-md border border-[#333744] bg-[#0e1016] px-3.5 py-2.5 font-serif text-[14px] text-[#d9dce4] placeholder:italic placeholder:text-[#6b7280] focus:border-[#c9922b] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/30"
				></textarea>
				<button
					type="button"
					onclick={() => addStoryLine(freeform)}
					disabled={!freeform.trim() || busy}
					class="flex h-[44px] items-center justify-center rounded-md bg-[#c9922b] px-4 font-serif text-sm font-semibold text-[#1a130a] transition hover:bg-[#b07f22] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/40 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Add
				</button>
			</div>
			<p class="mt-2 text-[11px] italic text-[#6b7280]">
				↻ refresh options · ＋ steer them · pick one or write your own
			</p>
		</div>
	</footer>
</section>
