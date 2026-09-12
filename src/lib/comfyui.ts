// Thin client for a local ComfyUI server (default http://localhost:8188).
// Mirrors how the app already talks to Ollama: plain fetch against a local
// HTTP API. Fully local — no cloud calls.
//
// Requests go through the Vite dev proxy (`/comfy` → localhost:8188) so the
// browser stays same-origin and ComfyUI's missing CORS headers don't 403 the
// /view image fetch. See vite.config.ts.
const COMFYUI_BASE = '/comfy';

// Stable identity for this browser tab; ComfyUI uses it to group a client's
// queued prompts (and to route websocket progress if we ever add it).
const CLIENT_ID =
	typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: `client-${Math.random().toString(36).slice(2)}`;

export interface GenerateImageOptions {
	/** Positive prompt describing the scene. */
	prompt: string;
	/** Negative prompt (optional). */
	negativePrompt?: string;
	/** Output width in pixels. Default 1024. */
	width?: number;
	/** Output height in pixels. Default 1024. */
	height?: number;
	/** Sampler steps. Default 20. */
	steps?: number;
	/** Guidance scale. FLUX likes ~1.0. Default 1.0. */
	cfg?: number;
	/** Fixed seed for reproducibility. Random when omitted. */
	seed?: number;
	/** UNET filename in models/diffusion_models. Default flux1-dev.safetensors. */
	model?: string;
}

interface OutputImage {
	filename: string;
	subfolder: string;
	type: string;
}

// Build a FLUX.1 text-to-image workflow in ComfyUI's API (graph) format.
// Node ids are arbitrary strings; edges reference [nodeId, outputIndex].
function buildFluxWorkflow(opts: GenerateImageOptions): Record<string, unknown> {
	const seed = opts.seed ?? Math.floor(Math.random() * 1e10);
	return {
		// Model + encoders + VAE
		'10': {
			class_type: 'UNETLoader',
			inputs: { unet_name: opts.model ?? 'flux1-dev.safetensors', weight_dtype: 'default' }
		},
		'11': {
			class_type: 'DualCLIPLoader',
			inputs: {
				clip_name1: 'clip_l.safetensors',
				clip_name2: 't5xxl_fp16.safetensors',
				type: 'flux'
			}
		},
		'12': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
		// Text conditioning
		'6': { class_type: 'CLIPTextEncode', inputs: { text: opts.prompt, clip: ['11', 0] } },
		'7': { class_type: 'CLIPTextEncode', inputs: { text: opts.negativePrompt ?? '', clip: ['11', 0] } },
		// Empty latent at the requested resolution
		'5': {
			class_type: 'EmptyLatentImage',
			inputs: { width: opts.width ?? 1024, height: opts.height ?? 1024, batch_size: 1 }
		},
		// Sampling + decode + save
		'3': {
			class_type: 'KSampler',
			inputs: {
				seed,
				steps: opts.steps ?? 20,
				cfg: opts.cfg ?? 1.0,
				sampler_name: 'euler',
				scheduler: 'beta',
				denoise: 1.0,
				model: ['10', 0],
				positive: ['6', 0],
				negative: ['7', 0],
				latent_image: ['5', 0]
			}
		},
		'4': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['12', 0] } },
		'13': { class_type: 'SaveImage', inputs: { filename_prefix: 'rainy_day', images: ['4', 0] } }
	};
}

// Queue a workflow and return its prompt id.
async function queuePrompt(workflow: Record<string, unknown>): Promise<string> {
	const res = await fetch(`${COMFYUI_BASE}/prompt`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID })
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`ComfyUI responded with ${res.status} — ${text || 'no detail'}`);
	}
	const data = (await res.json()) as { prompt_id?: string; error?: string };
	if (!data.prompt_id) throw new Error(data.error ?? 'ComfyUI did not return a prompt id');
	return data.prompt_id;
}

// Poll /history until the prompt completes, then return the first saved image.
async function waitForImage(promptId: string, timeoutMs = 600_000): Promise<OutputImage> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await fetch(`${COMFYUI_BASE}/history/${promptId}`);
		if (res.ok) {
			const data = (await res.json()) as Record<string, { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, { images?: OutputImage[] }> }>;
			const entry = data[promptId];
			if (entry) {
				if (entry.status?.status_str === 'error') {
					throw new Error('ComfyUI reported an error while generating the image');
				}
				if (entry.status?.completed) {
					for (const node of Object.values(entry.outputs ?? {})) {
						const images = node?.images;
						if (images && images.length) return images[0];
					}
					throw new Error('Generation finished but no image was saved');
				}
			}
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error('Timed out waiting for the image to finish generating');
}

// Resolve a saved image to a blob URL we can drop straight into an <img>.
async function imageToBlobUrl(img: OutputImage): Promise<string> {
	const url =
		`${COMFYUI_BASE}/view?filename=${encodeURIComponent(img.filename)}` +
		`&subfolder=${encodeURIComponent(img.subfolder)}&type=${encodeURIComponent(img.type)}`;
	const blob = await (await fetch(url)).blob();
	return URL.createObjectURL(blob);
}

/**
 * Generate an image locally via ComfyUI and return a blob URL for it.
 * Resolves when the image is ready; rejects with a readable Error otherwise.
 */
export async function generateImage(opts: GenerateImageOptions): Promise<string> {
	const promptId = await queuePrompt(buildFluxWorkflow(opts));
	const img = await waitForImage(promptId);
	return imageToBlobUrl(img);
}

/** Quick liveness check — true if the ComfyUI server is reachable. */
export async function isComfyUIUp(): Promise<boolean> {
	try {
		const res = await fetch(`${COMFYUI_BASE}/system_stats`, { method: 'GET' });
		return res.ok;
	} catch {
		return false;
	}
}
