// Thin client for a local Ollama server (default http://localhost:11434).
// Mirrors how the app already talks to ComfyUI: plain fetch against a local
// HTTP API. Fully local — no cloud calls.

const OLLAMA_URL = 'http://localhost:11434/api/chat';

// The story always runs on the local 128K Qwen build — no selector needed.
export const DEFAULT_MODEL = 'orcarouter/Qwen3.8-27B-128k';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatPayload {
	model: string;
	stream?: boolean;
	messages: ChatMessage[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stream a chat request, calling onDelta with each content chunk as it
// arrives. Surfaces the server's own error body; retries once on 5xx.
export async function streamChat(
	payload: ChatPayload,
	onDelta: (delta: string) => void
): Promise<void> {
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
