<script lang="ts">
	import PaintPanel from './PaintPanel.svelte';
	import NextMoves from './NextMoves.svelte';
	import { messages, busy, usedTokens, contextPct, firstStoryId, contextLimit } from '../story.svelte.ts';

	// Local UI state only — shared story state and logic live in ../story.ts
	// (the app's "service": a module of runes + functions any component can use).
	let scrollEl: HTMLElement | undefined = $state();
	const DROP_CAP =
		'first-letter:float-left first-letter:mr-2 first-letter:mt-0.5 first-letter:inline-block first-letter:text-5xl first-letter:leading-[0.85] first-letter:font-serif';

	function scrollToBottom(): void {
		if (scrollEl) {
			scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
		}
	}

	$effect(() => {
		// Keep the newest message in view whenever the list changes.
		scrollToBottom();
	});
</script>

<section
	aria-label="Story book"
	class="flex h-full w-full max-w-5xl overflow-hidden rounded-lg border border-[#2b2f3a] bg-[#151821] shadow-2xl shadow-black/50"
>
	<div class="flex min-w-0 flex-1 flex-col">
	<header class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#2b2f3a] px-6 py-4">
		<div class="min-w-0 leading-tight">
			<h2 class="font-serif text-lg font-semibold tracking-wide text-[#ece7db]">
				Rainy Day Stories
			</h2>
			<p class="text-xs italic text-[#8a90a0]">
				Told to you by Ollama
			</p>
		</div>

		<div class="ml-auto flex items-center gap-4">
			<div
				class="flex items-center gap-2"
				title={`${usedTokens()} / ${contextLimit()} tokens used — how much of the story is remembered`}
			>
				<span class="text-[10px] uppercase tracking-wide text-[#8a90a0]">Pages</span>
				<div class="h-2 w-24 overflow-hidden rounded-full bg-[#232733]">
					<div
						class="h-full rounded-full transition-all duration-300 {contextPct() >= 85 ? 'bg-[#e0685c]' : contextPct() >= 60 ? 'bg-[#d9a441]' : 'bg-[#8aa05f]'}"
						style={`width: ${contextPct()}%`}
					></div>
				</div>
				<span class="text-xs tabular-nums text-[#8a90a0]">{contextPct().toFixed(0)}%</span>
			</div>
		</div>
	</header>

	<div
		bind:this={scrollEl}
		class="flex-1 overflow-y-auto px-7 py-6"
	>
		<div class="mx-auto max-w-prose">
			{#each messages() as message (message.id)}
				{#if message.role === 'assistant'}
					<p
						class="whitespace-pre-wrap font-serif text-[17px] leading-[1.85] text-[#e3ddcf] {message.id === firstStoryId() ? DROP_CAP : 'mt-5'}"
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

			{#if busy()}
				<p class="mt-5 font-serif text-[17px] italic leading-[1.85] text-[#7d8496]">
					The narrator is weighing the next moment…
				</p>
			{/if}
		</div>
	</div>

	<NextMoves />
	</div>

	<!-- Right rail: collapsible paint panel -->
	<PaintPanel />
</section>
