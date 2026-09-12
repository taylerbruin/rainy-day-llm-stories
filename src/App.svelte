<script lang="ts">
	import Chat from './lib/components/Chat.svelte';
</script>

<main class="flex h-screen w-full flex-col">
	<header class="flex items-center gap-2 px-6 pt-5 pb-1">
		<span class="text-lg">🌧️</span>
		<h1 class="text-lg font-semibold tracking-tight text-neutral-100">Rainy Day LLM Stories</h1>
	</header>

	<div class="flex min-h-0 flex-1 items-center justify-center px-4 pb-5 pt-2">
		<Chat />
	</div>
</main>
