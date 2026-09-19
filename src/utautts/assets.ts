/**
 * Asset loading for the TTS stack: the Go UtauTTS wasm (~10 MB), the
 * jpreprocess wasm (~2 MB) and its naist-jdic dictionary (~29 MB gzipped,
 * ~80 MB inflated) and the TCN prosody model (~1 MB).
 *
 * Everything goes through {@link fetchAsset}, which streams the download with
 * progress callbacks and stores the raw response in the Cache API so the second
 * visit skips the network entirely (the browser HTTP cache alone is not
 * reliable for files this size).
 */

export interface AssetProgress {
	url: string;
	/** Bytes received so far (compressed bytes for gzipped files). */
	loaded: number;
	/** Total bytes when the server sent Content-Length, otherwise 0. */
	total: number;
	/** True when served from the Cache API (no network). */
	fromCache: boolean;
}

export interface AssetFetchOptions {
	/**
	 * Cache API bucket name. `null` disables caching. Defaults to
	 * `"koe-tts-assets-v1"`.
	 */
	cacheName?: string | null;
	onProgress?: (progress: AssetProgress) => void;
	signal?: AbortSignal;
	/**
	 * Check the cached copy against the server with a HEAD request (ETag,
	 * Last-Modified or Content-Length) so a redeployed asset is refetched.
	 * Offline or on error the cached copy is used. Default true.
	 */
	revalidate?: boolean;
}

const DEFAULT_CACHE = "koe-tts-assets-v1";

async function openCache(
	name: string | null | undefined,
): Promise<Cache | null> {
	if (name === null) return null;
	try {
		if (typeof caches === "undefined") return null;
		return await caches.open(name ?? DEFAULT_CACHE);
	} catch {
		// file:// pages, private windows and insecure origins have no Cache API.
		return null;
	}
}

/**
 * HEAD the asset and compare validators with the cached copy. Network errors
 * (offline) count as "current" so the cache keeps working without a server.
 */
async function cachedCopyIsCurrent(
	url: string,
	cached: Response,
	signal?: AbortSignal,
): Promise<boolean> {
	let head: Response;
	try {
		head = await fetch(url, { method: "HEAD", signal, cache: "no-cache" });
	} catch {
		return true;
	}
	if (!head.ok) return true;
	for (const name of ["etag", "last-modified", "content-length"]) {
		const remote = head.headers.get(name);
		const local = cached.headers.get(name);
		if (remote && local) return remote === local;
	}
	return true;
}

/**
 * Fetch a static asset with download progress, backed by the Cache API.
 *
 * The returned Response has a fully buffered body, so it can be handed to
 * `WebAssembly.instantiateStreaming` / wasm-bindgen `init()` as-is.
 */
export async function fetchAsset(
	url: string,
	options: AssetFetchOptions = {},
): Promise<Response> {
	const { onProgress, signal, revalidate = true } = options;
	const cache = await openCache(options.cacheName);
	if (cache) {
		try {
			const hit = await cache.match(url);
			if (
				hit &&
				(!revalidate || (await cachedCopyIsCurrent(url, hit, signal)))
			) {
				const total = Number(hit.headers.get("content-length")) || 0;
				onProgress?.({ url, loaded: total, total, fromCache: true });
				return hit;
			}
		} catch {
			// fall through to the network
		}
	}

	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`fetch ${url}: HTTP ${response.status}`);
	}
	const total = Number(response.headers.get("content-length")) || 0;
	let body: Uint8Array<ArrayBuffer>;
	if (response.body && onProgress) {
		const reader = response.body.getReader();
		const parts: Uint8Array[] = [];
		let loaded = 0;
		onProgress({ url, loaded, total, fromCache: false });
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value);
			loaded += value.byteLength;
			onProgress({ url, loaded, total, fromCache: false });
		}
		body = new Uint8Array(new ArrayBuffer(loaded));
		let offset = 0;
		for (const part of parts) {
			body.set(part, offset);
			offset += part.byteLength;
		}
	} else {
		body = new Uint8Array(await response.arrayBuffer());
		onProgress?.({
			url,
			loaded: body.byteLength,
			total: total || body.byteLength,
			fromCache: false,
		});
	}

	const headers = new Headers();
	for (const name of ["content-type", "etag", "last-modified"]) {
		const value = response.headers.get(name);
		if (value) headers.set(name, value);
	}
	headers.set("content-length", String(body.byteLength));
	const buffered = new Response(body, { status: 200, headers });
	if (cache) {
		try {
			await cache.put(url, buffered.clone());
		} catch {
			// quota exceeded or opaque response: caching is best effort
		}
	}
	return buffered;
}

/** {@link fetchAsset} and return the body bytes. */
export async function fetchAssetBytes(
	url: string,
	options?: AssetFetchOptions,
): Promise<Uint8Array> {
	return new Uint8Array(await (await fetchAsset(url, options)).arrayBuffer());
}

/** {@link fetchAsset} and return the body as text. */
export async function fetchAssetText(
	url: string,
	options?: AssetFetchOptions,
): Promise<string> {
	return (await fetchAsset(url, options)).text();
}

/** The naist-jdic files produced by jpreprocess's dictionary build, in `init_dictionary` order. */
export const NAIST_JDIC_FILES = [
	"metadata.json",
	"char_def.bin",
	"matrix.mtx",
	"dict.da",
	"dict.vals",
	"unk.bin",
	"dict.wordsidx",
	"dict.words",
] as const;

export type NaistJdicFile = (typeof NAIST_JDIC_FILES)[number];

export type NaistJdicData = Record<NaistJdicFile, Uint8Array>;

/** The subset of the wasm-bindgen module surface used by koe. */
export interface JpreprocessModule {
	init_dictionary(
		metadata: Uint8Array,
		charDef: Uint8Array,
		matrix: Uint8Array,
		dictDa: Uint8Array,
		dictVals: Uint8Array,
		unk: Uint8Array,
		wordsIdx: Uint8Array,
		words: Uint8Array,
	): void;
	analyze_text(text: string): string;
	is_ready(): boolean;
	/** Load an HTS voice (.htsvoice bytes) for `analyze_prosody`. */
	init_voice?(htsvoice: Uint8Array): void;
	is_voice_ready?(): boolean;
	/** HTS phoneme durations + F0 for the text (JSON, see `HtsProsodyFrames`). */
	analyze_prosody?(text: string, speed: number): string;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === "undefined") {
		throw new Error(
			"DecompressionStream is not available; serve the dictionary uncompressed",
		);
	}
	const stream = new Blob([bytes as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface LoadNaistJdicOptions extends AssetFetchOptions {
	/** Files are `<name>.gz` and inflated in the browser. Default true. */
	compressed?: boolean;
}

/**
 * Download (or read from the Cache API) the naist-jdic dictionary files for
 * jpreprocess. `baseUrl` is the directory holding `dict.da.gz` etc.
 *
 * Progress is reported per file via `onProgress`; sum `loaded`/`total` across
 * the {@link NAIST_JDIC_FILES} URLs for an aggregate bar.
 */
export async function loadNaistJdic(
	baseUrl: string,
	options: LoadNaistJdicOptions = {},
): Promise<NaistJdicData> {
	const { compressed = true, ...fetchOptions } = options;
	const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const entries = await Promise.all(
		NAIST_JDIC_FILES.map(async (name) => {
			const raw = await fetchAssetBytes(
				`${base}${name}${compressed ? ".gz" : ""}`,
				fetchOptions,
			);
			return [name, compressed ? await inflate(raw) : raw] as const;
		}),
	);
	return Object.fromEntries(entries) as NaistJdicData;
}

/** Hand the loaded dictionary to the jpreprocess wasm module (once per page). */
export function initJpreprocessDictionary(
	module: JpreprocessModule,
	data: NaistJdicData,
): void {
	module.init_dictionary(
		data["metadata.json"],
		data["char_def.bin"],
		data["matrix.mtx"],
		data["dict.da"],
		data["dict.vals"],
		data["unk.bin"],
		data["dict.wordsidx"],
		data["dict.words"],
	);
}
