// Story state + logic — the shared "service" for the app.
//
// A Svelte 5 module of runes + functions, not an injected class: $state and
// $derived work outside components, so every component that imports this
// module reads and writes the same reactive state. Any number of components
// can call the exported functions — they all see the same store.

import { streamChat, DEFAULT_MODEL, type ChatMessage } from './ollama';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
	id: number;
	role: 'user' | 'assistant';
	content: string;
}

export type OptionType = 'do' | 'say' | 'other';

export interface StoryOption {
	id: number;
	type: OptionType;
	text: string;
}

// ---------------------------------------------------------------------------
// Shared reactive state
// ---------------------------------------------------------------------------

let idCounter = 0;
const nextId = () => idCounter++;

let _messages: Message[] = $state([
	{
		id: nextId(),
		role: 'assistant',
		content: "Hey — I'm the story window, running on Ollama. Tell me something and I'll reply. ☔"
	}
]);

// Busy while the option model is streaming. Shared so Chat can show its own
// "narrator is weighing…" indicator.
let _busy = $state(false);

let _storyOptions = $state<StoryOption[]>([]);
let _error = $state<string | null>(null);

// ---------------------------------------------------------------------------
// Context usage tracking (for the "Pages" meter in the Chat header)
// ---------------------------------------------------------------------------

const CONTEXT_LIMIT = 131072;

// Real prompt tokens from Ollama when known, otherwise a character-based
// estimate. contextLimit is the model's max context window.
let promptTokens = $state<number | null>(null);
let _contextLimit = $state(CONTEXT_LIMIT);

const estimatedTokens = $derived(
	_messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
);

// State can't be exported directly from a module (Svelte 5 forbids exporting
// reassigned state), so every piece of shared state is exposed as an
// accessor function. Components stay reactive when they call these.
function messages(): Message[] {
	return _messages;
}

function busy(): boolean {
	return _busy;
}

function storyOptions(): StoryOption[] {
	return _storyOptions;
}

function error(): string | null {
	return _error;
}

function contextLimit(): number {
	return _contextLimit;
}

// Derived values can't be exported directly from a module — expose them as
// functions so components stay reactive when they call them.
function usedTokens(): number {
	return promptTokens ?? estimatedTokens;
}

function contextPct(): number {
	return Math.min(100, (usedTokens() / contextLimit()) * 100);
}

// The first story paragraph gets a drop cap (consumed by Chat).
function firstStoryId(): number | undefined {
	return messages().find((m) => m.role === 'assistant')?.id;
}

export {
	messages,
	busy,
	storyOptions,
	error,
	contextLimit,
	usedTokens,
	contextPct,
	firstStoryId
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// Append a line to the story.
export function addLine(text: string): void {
	const clean = text.trim();
	if (!clean) return;
	_messages = [..._messages, { id: nextId(), role: 'user', content: clean }];
}

// Add a narrator line (e.g. from a future narrator generator).
export function addNarratorLine(text: string): void {
	const clean = text.trim();
	if (!clean) return;
	_messages = [..._messages, { id: nextId(), role: 'assistant', content: clean }];
}

const OPTION_CONTEXT_MESSAGES = 3;
const OPTION_COUNT = 4;

// Ask the model for a small set of distinct next moves, streaming the reply
// so options appear one-by-one as they're generated. Only the most recent
// slice of the conversation is sent as context. An optional `instruction`
// (e.g. "kill the orc") steers what the options focus on.
export async function generateOptions(instruction?: string): Promise<void> {
	if (_busy) return;

	_busy = true;
	_error = null;
	_storyOptions = [];
	const steer = (instruction ?? '').trim();

	// Ollama wants the context to end on a user turn; after the narrator
	// adds a line the transcript can end on an assistant message, which
	// triggers "no user query found in messages".
	const recent = _messages
		.slice(-OPTION_CONTEXT_MESSAGES)
		.map((m) => ({ role: m.role, content: m.content }));
	if (recent.length === 0 || recent[recent.length - 1].role !== 'user') {
		recent.push({ role: 'user', content: 'What happens next?' });
	}

	const steerLine = steer
		? `The player wants to focus the options on this: "${steer}". Weave it into each option where it fits.\n`
		: '';

	const payload: ChatMessage[] = [
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
	];

	let raw = '';
	let scanIndex = 0;
	let emitted = 0;

	const reveal = (objJson: string) => {
		if (emitted++ >= OPTION_COUNT) return;
		try {
			const option = itemToOption(JSON.parse(objJson));
			if (option) _storyOptions = [..._storyOptions, option];
		} catch {
			/* skip a malformed fragment */
		}
	};

	try {
		await streamChat({ model: DEFAULT_MODEL, stream: true, messages: payload }, (delta) => {
			raw += delta;
			const { objects, nextStart } = extractObjects(raw, scanIndex);
			for (const obj of objects) reveal(obj);
			scanIndex = nextStart;
		});

		// Fallback: the model returned something that isn't a stream of
		// objects (e.g. plain strings or a line list) — parse the whole thing.
		if (_storyOptions.length === 0) {
			for (const option of parseOptions(raw.trim())) {
				_storyOptions = [..._storyOptions, option];
			}
		}
	} catch (err) {
		_storyOptions = [];
		_error = err instanceof Error ? err.message : 'Something went wrong';
	} finally {
		_busy = false;
	}
}

// Clear the current option list (e.g. after a line is committed).
export function clearOptions(): void {
	_storyOptions = [];
	_error = null;
}

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------

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

// Turn the model's reply into typed options. Handles a clean JSON array of
// {type,text} objects, a JSON array of plain strings, or a line-broken list.
function parseOptions(raw: string): StoryOption[] {
	if (!raw) return [];

	const toOption = (type: OptionType | undefined, text: string): StoryOption | null => {
		const clean = text.trim();
		return clean ? { id: nextId(), type: type ?? guessType(clean), text: clean } : null;
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
	if (
		/^(run|hit|take|grab|open|close|climb|hide|attack|throw|pull|pick|turn|leave|cut|break|point|aim)/i.test(
			text
		)
	) {
		return 'do';
	}
	return 'other';
}
