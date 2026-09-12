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

	let draft = $state('');
	let scrollEl: HTMLElement | undefined = $state();
	let busy = $state(false);

	const OLLAMA_URL = 'http://localhost:11434/api/chat';
	const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags';
	const DEFAULT_MODEL = 'qwen3.8:latest';
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

	async function sendMessage(): Promise<void> {
		const text = draft.trim();
		if (!text || busy) return;

		// Append the user's message and clear the input immediately.
		messages = [...messages, { id: nextId(), role: 'user', content: text }];
		draft = '';

		// Send the full transcript to Ollama.
		const payload = {
			model: selectedModel,
			stream: false,
			messages: messages.map((m) => ({ role: m.role, content: m.content }))
		};

		busy = true;
		try {
			const res = await fetch(OLLAMA_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});

			if (!res.ok) {
				throw new Error(`Ollama responded with ${res.status}`);
			}

			const data: {
				message?: { content?: string };
				prompt_eval_count?: number;
			} = await res.json();
			const reply = data.message?.content?.trim() || '(no response)';
			if (typeof data.prompt_eval_count === 'number') {
				promptTokens = data.prompt_eval_count;
			}
			messages = [...messages, { id: nextId(), role: 'assistant', content: reply }];
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Something went wrong';
			messages = [
				...messages,
				{ id: nextId(), role: 'assistant', content: `⚠️ Couldn't reach Ollama — ${message}` }
			];
		} finally {
			busy = false;
		}
	}

	function onKeyDown(e: KeyboardEvent): void {
		// Enter sends, Shift+Enter inserts a newline.
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
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
					The narrator is writing…
				</p>
			{/if}
		</div>
	</div>

	<footer class="border-t border-[#2b2f3a] px-7 py-4">
		<div class="mx-auto flex max-w-prose items-end gap-3">
			<textarea
				bind:value={draft}
				onkeydown={onKeyDown}
				rows="1"
				placeholder="Guide the story — what happens next?"
				class="max-h-40 min-h-[44px] flex-1 resize-none rounded-md border border-[#333744] bg-[#0e1016] px-3.5 py-2.5 font-serif text-[15px] text-[#d9dce4] placeholder:italic placeholder:text-[#6b7280] focus:border-[#c9922b] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/30"
			></textarea>
			<button
				type="button"
				onclick={sendMessage}
				disabled={!draft.trim() || busy}
				class="flex h-[44px] items-center justify-center rounded-md bg-[#c9922b] px-5 font-serif text-sm font-semibold text-[#1a130a] transition hover:bg-[#b07f22] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/50 disabled:cursor-not-allowed disabled:opacity-40"
			>
				{busy ? 'Writing…' : 'Continue'}
			</button>
		</div>
		<p class="mx-auto mt-2 max-w-prose text-[11px] italic text-[#6b7280]">
			Press Enter to continue the story · Shift+Enter for a new line
		</p>
	</footer>
</section>
