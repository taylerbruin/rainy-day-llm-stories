<script lang="ts">
	import { onMount } from 'svelte';
	import { generateImage, isComfyUIUp } from '../comfyui';

	// Collapsed by default — only the vertical rail shows. Toggled open via the rail.
	let open = $state(false);

	// Local image generation via ComfyUI (FLUX.1-dev). Fully offline.
	let comfyUp = $state(false);
	let generating = $state(false);
	let genPrompt = $state('');
	let genError = $state<string | null>(null);

	// Generated images, newest first. Each is a blob URL + the prompt used.
	interface GeneratedImage {
		id: number;
		url: string;
		prompt: string;
	}
	let images = $state<GeneratedImage[]>([]);

	let idCounter = 0;
	const nextId = () => idCounter++;

	async function generateScene(): Promise<void> {
		const prompt = genPrompt.trim();
		if (!prompt || generating) return;
		generating = true;
		genError = null;
		try {
			const url = await generateImage({ prompt, width: 1024, height: 1024 });
			images = [{ id: nextId(), url, prompt }, ...images];
			genPrompt = '';
		} catch (err) {
			genError = err instanceof Error ? err.message : 'Image generation failed';
		} finally {
			generating = false;
		}
	}

	function onGenKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			generateScene();
		}
	}

	onMount(() => {
		isComfyUIUp().then((up) => (comfyUp = up));
	});
</script>

<div class="flex h-full shrink-0 items-stretch">
	{#if open}
		<aside
			aria-label="Paint a scene"
			class="flex w-72 flex-col border-l border-[#2b2f3a] bg-[#12151d]"
		>
			<header class="flex items-center justify-between gap-2 border-b border-[#2b2f3a] px-4 py-3">
				<h3 class="font-serif text-sm font-semibold text-[#ece7db]">
					🎨 Paint a scene
				</h3>
				<span
					class="flex items-center gap-1.5 text-[11px] text-[#8a90a0]"
					title="Status of the local ComfyUI server"
				>
					<span
						class="h-2 w-2 rounded-full {comfyUp ? 'bg-[#8aa05f]' : 'bg-[#e0685c]'}"
					></span>
				</span>
			</header>

			<div class="flex-1 overflow-y-auto px-4 py-4">
				<div class="flex items-end gap-2">
					<textarea
						bind:value={genPrompt}
						onkeydown={onGenKeyDown}
						rows="2"
						placeholder="Describe the scene — e.g. a rain-soaked alley at night, neon reflections"
						class="max-h-32 min-h-[44px] w-full resize-none rounded-md border border-[#333744] bg-[#0e1016] px-3.5 py-2.5 font-serif text-[14px] text-[#d9dce4] placeholder:italic placeholder:text-[#6b7280] focus:border-[#c9922b] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/30"
					></textarea>
				</div>
				<button
					type="button"
					onclick={() => generateScene()}
					disabled={!genPrompt.trim() || generating}
					class="mt-2 flex h-[40px] w-full items-center justify-center rounded-md bg-[#c9922b] px-4 font-serif text-sm font-semibold text-[#1a130a] transition hover:bg-[#b07f22] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/40 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{#if generating}
						<span
							class="h-4 w-4 animate-spin rounded-full border-2 border-[#1a130a]/40 border-t-[#1a130a]"
						></span>
					{:else}
						Generate
					{/if}
				</button>

				{#if genError}
					<div
						class="mt-2 flex items-start gap-2 rounded-md border border-[#5a2b2b] bg-[#2a1717] px-3.5 py-2.5 text-[13px] text-[#e0a9a0]"
						role="alert"
					>
						<span class="mt-0.5">⚠️</span>
						<span>{genError}</span>
					</div>
				{/if}

				{#if images.length}
					<div class="mt-4 grid grid-cols-2 gap-3">
						{#each images as image (image.id)}
							<figure class="group relative overflow-hidden rounded-md border border-[#2b2f3a] bg-[#0e1016]">
								<img
									src={image.url}
									alt={image.prompt}
									class="aspect-square w-full object-cover"
								/>
								<figcaption
									class="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2.5 py-1.5 text-[11px] text-[#d9dce4] opacity-0 transition group-hover:opacity-100"
								>
									{image.prompt}
								</figcaption>
							</figure>
						{/each}
					</div>
				{:else}
					<p class="mt-4 text-center text-xs italic text-[#6b7280]">
						No scenes yet — describe one above.
					</p>
				{/if}
			</div>

			<div class="border-t border-[#2b2f3a] p-3">
				<button
					type="button"
					onclick={() => (open = false)}
					aria-label="Collapse the paint panel"
					class="flex h-9 w-full items-center justify-center rounded-md border border-[#333744] bg-[#0e1016] text-xs font-semibold text-[#9aa0b0] transition hover:border-[#c9922b] hover:text-[#ece7db] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/40"
				>
					→ collapse
				</button>
			</div>
		</aside>
	{:else}
		<button
			type="button"
			onclick={() => (open = true)}
			aria-label="Open the paint panel"
			title="Paint a scene"
			class="group flex h-full w-9 shrink-0 flex-col items-center justify-center gap-3 border-l border-[#2b2f3a] bg-[#12151d] text-[#8a90a0] transition hover:bg-[#171a22] hover:text-[#c9922b] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#c9922b]/40"
		>
			<span class="text-base leading-none">🎨</span>
			<span
				class="font-serif text-[11px] font-semibold uppercase tracking-[0.25em] [writing-mode:vertical-rl] group-hover:tracking-[0.3em]"
			>
				Paint a scene
			</span>
		</button>
	{/if}
</div>
