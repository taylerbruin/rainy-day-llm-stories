<script lang="ts">
    import {
        busy,
        storyOptions,
        error,
        generateOptions,
        addLine,
        clearOptions,
    } from "../story.svelte.ts";

    // Local UI state only — shared story state and logic live in ../story.ts
    // (the app's "service": a module of runes + functions any component can use).
    let freeform = $state("");
    let instruction = $state("");
    let instructionOpen = $state(false);

    // Hand a chosen or written line to the story and reset the panel.
    function submitLine(text: string): void {
        const clean = text.trim();
        if (!clean || busy()) return;
        addLine(clean);
        clearOptions();
        freeform = "";
    }

    function onKeyDown(e: KeyboardEvent): void {
        // Enter adds the line, Shift+Enter inserts a newline.
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submitLine(freeform);
        }
    }
</script>

<footer class="border-t border-[#2b2f3a] px-7 py-4">
    <div class="mx-auto max-w-prose">
        <div class="flex items-center justify-between gap-3">
            <h3 class="font-serif text-sm font-semibold text-[#ece7db]">
                What do you do next?
            </h3>

            <div
                class="flex items-stretch overflow-hidden rounded-md border border-[#333744]"
            >
                <button
                    type="button"
                    onclick={() => generateOptions()}
                    disabled={busy()}
                    aria-label="Refresh options"
                    title="Regenerate options from the recent story"
                    class="flex w-11 items-center justify-center bg-[#0e1016] text-[#9aa0b0] transition hover:bg-[#171a22] hover:text-[#ece7db] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#c9922b]/40 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    {#if busy()}
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
                    disabled={busy()}
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

        {#if instructionOpen && !busy()}
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
                        instruction = "";
                        instructionOpen = false;
                    }}
                    disabled={busy()}
                    class="flex h-[44px] items-center justify-center rounded-md bg-[#c9922b] px-4 font-serif text-sm font-semibold text-[#1a130a] transition hover:bg-[#b07f22] focus:outline-none focus:ring-2 focus:ring-[#c9922b]/40 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    Generate
                </button>
            </div>
        {/if}

        {#if error()}
            <div
                class="mt-3 flex items-start gap-2 rounded-md border border-[#5a2b2b] bg-[#2a1717] px-3.5 py-2.5 text-[13px] text-[#e0a9a0]"
                role="alert"
            >
                <span class="mt-0.5">⚠️</span>
                <span>{error()}</span>
            </div>
        {/if}

        {#if storyOptions().length}
            <ul class="mt-3 space-y-2">
                {#each storyOptions() as option (option.id)}
                    <li
                        class="flex items-center gap-3 rounded-md border border-[#2b2f3a] bg-[#0e1016] px-3.5 py-2.5 transition hover:border-[#c9922b] hover:bg-[#171a22]"
                    >
                        <p
                            class="min-w-0 flex-1 font-serif text-[14px] leading-relaxed text-[#c9c3b4]"
                        >
                            {option.text}
                        </p>
                        <button
                            type="button"
                            onclick={() => submitLine(option.text)}
                            disabled={busy()}
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
                onclick={() => submitLine(freeform)}
                disabled={!freeform.trim() || busy()}
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
