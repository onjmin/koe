import type { PhonemeEntry } from "../types.js";

/** Output sample rate of the worldline synthesizer. */
export const WORLDLINE_SAMPLE_RATE = 48000;

/**
 * WORLD needs roughly 85 ms of audio for stable F0 analysis. Phonemes with
 * fewer samples than this are rejected (renderNote returns null).
 */
export const MIN_WORLDLINE_SAMPLES = 4096;

/** SynthRequest struct layout — 120 bytes, WASM32. */
const SYNTH_REQ_SIZE = 120;
/** Frame period hardcoded in worldline's phrase_synth.cpp. */
const WL_FRAME_MS = 10;

/**
 * The subset of the Emscripten module surface that we call. worldline.js is an
 * MODULARIZE=1 / EXPORT_NAME=WorldlineModule build of OpenUtau's worldline.
 */
interface WorldlineWasm {
	_PhraseSynthNew(): number;
	_PhraseSynthDelete(ps: number): void;
	_PhraseSynthAddRequest(
		ps: number,
		req: number,
		posMs: number,
		skipMs: number,
		lengthMs: number,
		fadeInMs: number,
		fadeOutMs: number,
		flag: number,
	): void;
	_PhraseSynthSetCurves(
		ps: number,
		f0: number,
		gender: number,
		tension: number,
		breathiness: number,
		voicing: number,
		length: number,
		frameMs: number,
	): void;
	_PhraseSynthSynth(ps: number, yPtrPtr: number, flag: number): number;
	_malloc(size: number): number;
	_free(ptr: number): void;
	setValue(ptr: number, value: number, type: string): void;
	getValue(ptr: number, type: string): number;
	HEAPF32: Float32Array;
	HEAPF64: Float64Array;
}

type WorldlineFactory = (opts?: {
	locateFile?: (path: string) => string;
}) => Promise<WorldlineWasm>;

declare global {
	// Injected by worldline.js when loaded as a classic <script> or via importScripts.
	// eslint-disable-next-line no-var
	var WorldlineModule: WorldlineFactory | undefined;
	// Present in classic Web Workers (used to load worldline.js off the main thread).
	// eslint-disable-next-line no-var
	var importScripts: ((...urls: string[]) => void) | undefined;
}

export interface WorldlineLoadOptions {
	/**
	 * URL of `worldline.js` (the Emscripten loader). The matching
	 * `worldline.wasm` must sit next to it — it is resolved relative to this URL.
	 *
	 * When consuming koe from npm + a CDN this is typically e.g.
	 * `https://cdn.jsdelivr.net/npm/@onjmin/koe/dist/world/worldline.js`, or your
	 * own hosted copy of `dist/world/`.
	 */
	scriptUrl: string;
}

export interface RenderNoteParams {
	/**
	 * Source phoneme PCM normalised to [-1, 1] (e.g. from
	 * `VoiceBank.getPcm()` / `KoeEngine.getPcm()`).
	 */
	pcm: Float64Array;
	/** Target output pitch in Hz. */
	pitch: number;
	/** Sustain / vowel duration in ms (the lead-in below is rendered on top). */
	durationMs: number;
	/** Preutterance / lead-in in ms — convert from {@link PhonemeEntry.pre}. */
	preMs: number;
	/** Consonant length in ms — convert from {@link PhonemeEntry.consonant}. */
	consonantMs: number;
	/** Reference tempo in BPM for worldline's internal timing. Default 120. */
	tempo?: number;
}

/** Convert a sample count at 48 kHz to milliseconds. */
export const samplesToMs = (samples: number): number =>
	(samples / WORLDLINE_SAMPLE_RATE) * 1000;

/**
 * Derive {@link RenderNoteParams} lead-in / consonant fields from a manifest
 * entry, so callers don't repeat the sample→ms conversion.
 *
 *   const params = { pcm, pitch, durationMs, ...leadInFromEntry(entry) };
 */
export function leadInFromEntry(entry: PhonemeEntry): {
	preMs: number;
	consonantMs: number;
} {
	return {
		preMs: samplesToMs(entry.pre || 0),
		consonantMs: samplesToMs(entry.consonant || 0),
	};
}

// Cache module factories by script URL so repeated loads share one WASM instance.
const moduleCache = new Map<string, Promise<WorldlineWasm>>();

function injectScript(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const existing = document.querySelector<HTMLScriptElement>(
			`script[data-koe-worldline="${src}"]`,
		);
		if (existing) {
			resolve();
			return;
		}
		const s = document.createElement("script");
		s.src = src;
		s.dataset.koeWorldline = src;
		s.onload = () => resolve();
		s.onerror = () => reject(new Error(`worldline: failed to load ${src}`));
		document.head.appendChild(s);
	});
}

function loadWasm(scriptUrl: string): Promise<WorldlineWasm> {
	const cached = moduleCache.get(scriptUrl);
	if (cached) return cached;

	const baseUrl = scriptUrl.slice(0, scriptUrl.lastIndexOf("/") + 1);
	const instantiate = (): Promise<WorldlineWasm> => {
		const factory = globalThis.WorldlineModule;
		if (!factory)
			throw new Error(
				"worldline: WorldlineModule global was not defined by the script",
			);
		// locateFile resolves worldline.wasm next to the script; fetch works in both
		// the DOM and Web Workers, so the WASM instantiates the same way off-thread.
		return factory({ locateFile: (f: string) => baseUrl + f });
	};

	let promise: Promise<WorldlineWasm>;
	if (typeof document !== "undefined") {
		// Main thread / DOM: load worldline.js via a <script> tag.
		promise = injectScript(scriptUrl).then(instantiate);
	} else if (typeof globalThis.importScripts === "function") {
		// Classic Web Worker: importScripts runs worldline.js synchronously in the
		// worker's global scope, defining globalThis.WorldlineModule. This lets the
		// heavy WORLD synthesis run off the main thread.
		promise = Promise.resolve().then(() => {
			(globalThis.importScripts as (...urls: string[]) => void)(scriptUrl);
			return instantiate();
		});
	} else {
		return Promise.reject(
			new Error(
				"Worldline.load requires a DOM or a classic Web Worker (importScripts) to load worldline.js",
			),
		);
	}
	moduleCache.set(scriptUrl, promise);
	return promise;
}

/**
 * High-quality WORLD-vocoder note renderer (OpenUtau's worldline via WASM).
 *
 * Pure synthesis: PCM in → PCM out. No AudioContext, no scheduling — the caller
 * owns playback (schedule the returned buffer on its own timeline). Pair it with
 * {@link VoiceBank} for the source samples:
 *
 *   const bank = await VoiceBank.load(koeUrl);
 *   const wl   = await Worldline.load({ scriptUrl: '.../world/worldline.js' });
 *
 *   const entry = bank.manifest.phonemes[alias];
 *   const pcm   = await bank.getPcm(alias);
 *   const audio = wl.renderNote({
 *     pcm, pitch: 440, durationMs: 500, ...leadInFromEntry(entry),
 *   });
 *   // audio: Float32 @ 48 kHz, layout [lead-in/consonant ≈ preMs][vowel ≈ durationMs]
 */
export class Worldline {
	readonly sampleRate = WORLDLINE_SAMPLE_RATE;

	private constructor(private wasm: WorldlineWasm) {}

	/**
	 * Load + instantiate the worldline WASM module (deduped per scriptUrl).
	 *
	 * Works on the main thread (loads via `<script>`) and inside a classic Web
	 * Worker (loads via `importScripts`), so the heavy synthesis can run
	 * off-thread. The matching `worldline.wasm` is fetched next to scriptUrl.
	 */
	static async load(options: WorldlineLoadOptions): Promise<Worldline> {
		return new Worldline(await loadWasm(options.scriptUrl));
	}

	/**
	 * Render one note to Float32 PCM at 48 kHz.
	 *
	 * The output buffer is laid out as [lead-in/consonant ≈ preMs][vowel ≈
	 * durationMs], rendered from sample offset 0 (no leading silence). The vowel
	 * onset (the "beat") sits at ≈ preMs into the buffer, so a sequencer should
	 * place the buffer at `beatTime − preMs` and may trim/crossfade the lead-in.
	 *
	 * No internal crossfade is applied — apply fades externally.
	 *
	 * @returns Float32 PCM, or null when `pcm` is shorter than
	 *          {@link MIN_WORLDLINE_SAMPLES} (too short for stable F0 analysis).
	 */
	renderNote(params: RenderNoteParams): Float32Array | null {
		const { pcm, pitch, durationMs, preMs, consonantMs, tempo = 120 } = params;
		if (!pcm || pcm.length < MIN_WORLDLINE_SAMPLES) return null;

		const WL = this.wasm;
		const FS = WORLDLINE_SAMPLE_RATE;
		const midiNote = Math.round(69 + 12 * Math.log2(pitch / 440));
		const posMs = 0; // no leading silence
		const reqLen = preMs + durationMs; // render lead-in/consonant + vowel

		// cut_off must trim at least ~2 frames off the tail. PhraseSynth::AddRequest
		// computes the trim frame count as ceil(in_length_ms)/frame_ms, but
		// PyinEstimator yields floor(N/nhop)−1 frames — one fewer. With cut_off=0 the
		// requested frame count exceeds f0_.size() and Model::Trim's f0_.erase() runs
		// past end(), causing "memory access out of bounds". Trimming 2 frames keeps
		// it within bounds.
		const cutMs = WL_FRAME_MS * 2;

		const ps = WL._PhraseSynthNew();
		if (!ps) return null;
		const reqPtr = WL._malloc(SYNTH_REQ_SIZE);
		if (!reqPtr) {
			WL._PhraseSynthDelete(ps);
			return null;
		}
		const samplePtr = WL._malloc(pcm.length * 8);
		if (!samplePtr) {
			WL._free(reqPtr);
			WL._PhraseSynthDelete(ps);
			return null;
		}
		WL.HEAPF64.set(pcm, samplePtr >> 3);

		const sv = (off: number, val: number, type: string) =>
			WL.setValue(reqPtr + off, val, type);
		sv(0, FS, "i32");
		sv(4, pcm.length, "i32");
		sv(8, samplePtr, "*");
		sv(12, 0, "i32");
		sv(16, 0, "*");
		sv(20, midiNote, "i32");
		sv(24, 100.0, "double");
		sv(32, 0.0, "double");
		sv(40, reqLen, "double");
		sv(48, consonantMs, "double");
		sv(56, cutMs, "double");
		sv(64, 100.0, "double");
		sv(72, 0.0, "double");
		sv(80, tempo, "double");
		sv(88, 0, "i32");
		sv(92, 0, "*");
		sv(96, 0, "i32");
		sv(100, 0, "i32");
		sv(104, 100, "i32");
		sv(108, 0, "i32");
		sv(112, 0, "i32");
		sv(116, 100, "i32");

		// skip/fadeIn/fadeOut all 0 — crossfade is handled externally.
		WL._PhraseSynthAddRequest(ps, reqPtr, posMs, 0.0, reqLen, 0.0, 0.0, 0);
		WL._free(samplePtr);
		WL._free(reqPtr);

		const totalMs = posMs + reqLen + WL_FRAME_MS * 2;
		const nFrames = Math.ceil(totalMs / WL_FRAME_MS) + 4;
		const f0Arr = new Float64Array(nFrames).fill(pitch);
		const gArr = new Float64Array(nFrames).fill(0.5);
		const tArr = new Float64Array(nFrames).fill(0.5);
		const bArr = new Float64Array(nFrames).fill(0.5);
		const vArr = new Float64Array(nFrames).fill(1.0);

		const f0Ptr = WL._malloc(nFrames * 8);
		const gPtr = WL._malloc(nFrames * 8);
		const tPtr = WL._malloc(nFrames * 8);
		const bPtr = WL._malloc(nFrames * 8);
		const vPtr = WL._malloc(nFrames * 8);
		if (!f0Ptr || !gPtr || !tPtr || !bPtr || !vPtr) {
			if (f0Ptr) WL._free(f0Ptr);
			if (gPtr) WL._free(gPtr);
			if (tPtr) WL._free(tPtr);
			if (bPtr) WL._free(bPtr);
			if (vPtr) WL._free(vPtr);
			WL._PhraseSynthDelete(ps);
			return null;
		}
		WL.HEAPF64.set(f0Arr, f0Ptr >> 3);
		WL.HEAPF64.set(gArr, gPtr >> 3);
		WL.HEAPF64.set(tArr, tPtr >> 3);
		WL.HEAPF64.set(bArr, bPtr >> 3);
		WL.HEAPF64.set(vArr, vPtr >> 3);
		WL._PhraseSynthSetCurves(
			ps,
			f0Ptr,
			gPtr,
			tPtr,
			bPtr,
			vPtr,
			nFrames,
			WL_FRAME_MS,
		);
		WL._free(f0Ptr);
		WL._free(gPtr);
		WL._free(tPtr);
		WL._free(bPtr);
		WL._free(vPtr);

		const yPtrPtr = WL._malloc(4);
		if (!yPtrPtr) {
			WL._PhraseSynthDelete(ps);
			return null;
		}
		const outLen = WL._PhraseSynthSynth(ps, yPtrPtr, 0);
		const yPtr = WL.getValue(yPtrPtr, "*");
		const audio =
			outLen > 0
				? new Float32Array(WL.HEAPF32.buffer, yPtr, outLen).slice()
				: null;
		WL._free(yPtrPtr);
		WL._PhraseSynthDelete(ps);
		return audio;
	}
}
