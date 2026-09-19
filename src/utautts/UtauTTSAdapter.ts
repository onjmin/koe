import type { VoiceBank } from "../engine/voice-bank.js";
import {
	MIN_WORLDLINE_SAMPLES,
	type PhraseUnit,
	WORLDLINE_SAMPLE_RATE,
	type Worldline,
} from "../engine/worldline.js";
import type { HtsProsody } from "./hts.js";
import { type FeatureFrame, sparse_features } from "./openjtalk_features.js";

// ── Plan JSON produced by cmd/utautts-wasm ──────────────────────────────────

/** One unit of the UtauTTS synthesis plan (`internal/plan.Unit`). */
export interface UtauTTSUnit {
	position: number;
	role: string;
	mora: string;
	alias: string;
	note_start_ms: number;
	duration_ms: number;
	offset_ms: number;
	consonant_ms: number;
	cutoff_ms: number;
	preutterance_ms: number;
	overlap_ms: number;
	silent?: boolean;
	pitch_factor: number;
	energy_factor: number;
	effective_preutterance_ms: number;
	effective_consonant_ms: number;
	effective_overlap_ms: number;
	source_f0_hz?: number;
	target_f0_hz?: number;
	[extra: string]: unknown;
}

/** Placement of one unit on the worldline phrase timeline (`render.WorldlineTimelineUnit`). */
export interface UtauTTSTimelineUnit {
	index: number;
	position: number;
	role: string;
	mora: string;
	alias: string;
	note_start_ms: number;
	duration_ms: number;
	position_ms: number;
	skip_ms: number;
	length_ms: number;
	fade_in_ms: number;
	fade_out_ms: number;
	offset_ms: number;
	required_length_ms: number;
	consonant_ms: number;
	cutoff_ms: number;
	tone: number;
	consonant_velocity: number;
	volume: number;
	energy_factor: number;
	source_f0_hz: number;
	target_f0_hz: number;
	envelope?: { x_ms: number; y: number }[];
}

/** Whole-phrase placement + F0 curve (`render.WorldlineTimeline`). */
export interface UtauTTSTimeline {
	frame_ms: number;
	leading_ms: number;
	/** Timeline length in ms (plan duration + release + leading margin). */
	duration_ms: number;
	reference_hz: number;
	/** Target F0 in Hz per `frame_ms` frame, starting at timeline 0. */
	f0_curve: number[];
	units: UtauTTSTimelineUnit[];
}

export interface UtauTTSPlan {
	reading: string;
	language: string;
	morae: { Text: string; Consonant: string; Vowel: string; Pause: boolean }[];
	plan: {
		duration_ms: number;
		single_cv?: boolean;
		leading_margin_ms?: number;
		units: UtauTTSUnit[];
		[extra: string]: unknown;
	};
	/** Frame pitch curve in cents relative to each unit's own pitch (plan time base). */
	pitch_curve?: { frame_ms: number; cents: number[] };
	mora_timings: { StartMS: number; DurationMS: number }[];
	timeline: UtauTTSTimeline;
	/** @deprecated use `plan.duration_ms` */
	duration_ms: number;
	/** @deprecated use `plan.units` */
	units: UtauTTSUnit[];
	/** @deprecated use `pitch_curve` */
	pitch_cents?: number[];
	/** @deprecated use `pitch_curve` */
	pitch_frame_ms?: number;
}

interface WasmResult {
	success: boolean;
	error?: string;
	plan?: string;
	id?: string;
	aliases?: number;
}

declare function utautts_plan(requestJSON: string): WasmResult;
declare function utautts_set_model(modelJSON: string): WasmResult;
declare function utautts_set_bank(bankJSON: string): WasmResult;
declare class Go {
	importObject: WebAssembly.Imports;
	run(instance: WebAssembly.Instance): Promise<void>;
}

// ── Options ─────────────────────────────────────────────────────────────────

/** Synthesis parameters, same meaning and defaults as `utautts-cli` / the UtauTTS GUI. */
export interface UtauTTSOptions {
	/** Voicebank tone for prefix.map lookups. Default "C4". */
	tone?: string;
	/** Base mora length in ms (0 = UtauTTS default 140). */
	moraDurationMs?: number;
	/** Pause length for punctuation in ms (0 = UtauTTS default 180). */
	pauseDurationMs?: number;
	/** Release envelope in ms. Default 20. */
	releaseMs?: number;
	/** Cap on the leading preutterance margin before the first mora (0 = no cap). */
	leadingPreutteranceMs?: number;
	/** Apply the TCN frame pitch contour and source pitch stabilisation. Default true. */
	applyPitch?: boolean;
	/** Contour strength 0..4. Default 1. */
	intonationStrength?: number;
	/** UtauTTS experimental speech timing (voicebank calibration). Default false. */
	speechTiming?: boolean;
	wordBoundaryEnvelope?: boolean;
	/**
	 * External prosody (mora durations + cents curve) from `alignHtsProsody`.
	 * When set, UtauTTS uses these instead of its own durations and TCN contour;
	 * `intonationStrength` is applied by `alignHtsProsody`, not here.
	 */
	prosody?: HtsProsody;
}

/** One rendered piece of audio. Sum overlapping chunks: seams are equal-power crossfades. */
export interface UtauTTSChunk {
	/** Float32 PCM at 48 kHz. */
	pcm: Float32Array;
	/** Where the chunk starts on the timeline (ms from timeline 0). */
	startMs: number;
	index: number;
	/** Timeline units rendered into this chunk (context units for seams excluded). */
	units: UtauTTSTimelineUnit[];
}

export interface UtauTTSRenderOptions {
	/** Units in the first chunk (small → audio starts sooner). Default 3. */
	firstChunkUnits?: number;
	/** Units per later chunk. Default 6. */
	chunkUnits?: number;
	/** Crossfade length at a mid-phrase seam in ms. Default 20. */
	seamCrossfadeMs?: number;
	signal?: AbortSignal;
	gender?: number;
	tension?: number;
	breathiness?: number;
	voicing?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the kana reading UtauTTS parses from the jpreprocess token features,
 * so the mora sequence and the feature frames line up 1:1 by construction.
 */
export function readingFromFeatures(features: FeatureFrame[]): string {
	return features.map((frame) => (frame.pause ? "、" : frame.mora)).join("");
}

const FS = WORLDLINE_SAMPLE_RATE;
const msToSamples = (ms: number): number => Math.round((ms / 1000) * FS);

/** Sample the timeline F0 curve (Hz) at an absolute timeline time with linear interpolation. */
function f0At(timeline: UtauTTSTimeline, tMs: number): number {
	const curve = timeline.f0_curve;
	if (curve.length === 0) return timeline.reference_hz || 220;
	const position = Math.max(0, tMs) / timeline.frame_ms;
	const left = Math.floor(position);
	if (left >= curve.length - 1) return curve[curve.length - 1];
	const progress = position - left;
	return curve[left] * (1 - progress) + curve[left + 1] * progress;
}

interface ChunkRange {
	/** First own unit (inclusive). */
	start: number;
	/** Last own unit (exclusive). */
	end: number;
	/** Chunk starts mid-phrase (needs the previous unit as context + a seam fade-in). */
	headSeam: boolean;
	/** Chunk ends mid-phrase (needs the next unit as context + a seam fade-out). */
	tailSeam: boolean;
}

/**
 * Scale each timeline unit's volume by the gain of the mora it belongs to
 * (`HtsProsody.moraGains`, one entry per feature frame / plan mora). Units are
 * matched by their mora index when the counts agree, else by start time.
 */
function applyMoraGains(plan: UtauTTSPlan, gains: number[]): void {
	const morae = plan.morae ?? [];
	const timings = plan.mora_timings ?? [];
	const byIndex = morae.length === gains.length;
	const moraAt = (unit: UtauTTSTimelineUnit): number => {
		if (byIndex) return unit.position;
		let found = -1;
		for (let i = 0; i < timings.length && i < gains.length; i++) {
			if (timings[i].StartMS <= unit.note_start_ms + 1e-6) found = i;
			else break;
		}
		return found;
	};
	for (const unit of plan.timeline.units) {
		const index = moraAt(unit);
		const gain = gains[index];
		if (index < 0 || gain === undefined || !Number.isFinite(gain)) continue;
		unit.volume *= gain;
	}
}

/**
 * Split timeline units into chunks. Breaks are free where units do not overlap
 * (pauses); inside a phrase a break every N units costs one seam crossfade.
 */
function planChunks(
	units: UtauTTSTimelineUnit[],
	firstChunkUnits: number,
	chunkUnits: number,
): ChunkRange[] {
	const ranges: ChunkRange[] = [];
	if (units.length === 0) return ranges;
	let start = 0;
	let coveredEndMs = units[0].position_ms + units[0].length_ms;
	let headSeam = false;
	for (let i = 1; i <= units.length; i++) {
		const limit = ranges.length === 0 ? firstChunkUnits : chunkUnits;
		const atEnd = i === units.length;
		const clean = !atEnd && units[i].position_ms >= coveredEndMs - 1e-6;
		const full = !atEnd && i - start >= limit;
		if (atEnd || clean || full) {
			const tailSeam = !atEnd && !clean;
			ranges.push({ start, end: i, headSeam, tailSeam });
			start = i;
			headSeam = tailSeam;
			if (!atEnd) coveredEndMs = units[i].position_ms + units[i].length_ms;
			continue;
		}
		coveredEndMs = Math.max(
			coveredEndMs,
			units[i].position_ms + units[i].length_ms,
		);
	}
	return ranges;
}

/**
 * Where to cut between two chunks that share the boundary before `next`: just
 * after `next`'s fade-in, in its steady vowel, so both renders agree spectrally.
 */
function seamTimeMs(next: UtauTTSTimelineUnit, crossfadeMs: number): number {
	const earliest = next.position_ms + next.fade_in_ms + crossfadeMs / 2;
	const latest = next.position_ms + next.length_ms - crossfadeMs / 2;
	return Math.min(
		earliest,
		Math.max(next.position_ms + crossfadeMs / 2, latest),
	);
}

function applyFade(
	pcm: Float32Array,
	fromSample: number,
	samples: number,
	fadeIn: boolean,
): void {
	const n = Math.max(1, Math.min(samples, pcm.length - fromSample));
	for (let k = 0; k < n; k++) {
		const t = (k + 0.5) / n;
		const gain = fadeIn
			? Math.sin((Math.PI / 2) * t)
			: Math.cos((Math.PI / 2) * t);
		pcm[fromSample + k] *= gain;
	}
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Text-to-speech with UtauTTS's planner (Go wasm) and koe's worldline renderer.
 *
 * Pipeline per utterance:
 *  1. jpreprocess (caller) → NJD nodes → {@link FeatureFrame}s via `openjtalkAnalyze`
 *  2. {@link plan}: UtauTTS resolves units (Viterbi), builds the timing plan,
 *     predicts the TCN pitch contour and lays the units on the worldline timeline
 *     exactly as its native worldline bridge would
 *  3. {@link renderChunks}: worldline renders the timeline in small chunks so
 *     playback can start after the first few morae
 *
 * Load order: `initializeWasm()` once per page, `setModel()` once per model,
 * `setBank()` once per voice bank.
 */
export class UtauTTSAdapter {
	private static modelId: string | null = null;
	private bankAliases = new WeakMap<VoiceBank, number>();
	private currentBank: VoiceBank | null = null;
	private pcmCache = new Map<string, Promise<Float64Array | null>>();

	constructor(private worldline: Worldline) {}

	/**
	 * Load the UtauTTS Go wasm. `wasm_exec.js` must already be on the page.
	 * Pass `fetch` (e.g. koe's `fetchAsset`) to stream from the Cache API.
	 */
	static async initializeWasm(
		wasmUrl = "utautts.wasm",
		options: { fetch?: (url: string) => Promise<Response> } = {},
	): Promise<void> {
		if (typeof utautts_plan === "function") return;
		if (typeof Go === "undefined") {
			throw new Error(
				"wasm_exec.js must be loaded before calling initializeWasm.",
			);
		}
		const go = new Go();
		const responsePromise = (options.fetch ?? fetch)(wasmUrl);
		let instance: WebAssembly.Instance;
		try {
			instance = (
				await WebAssembly.instantiateStreaming(responsePromise, go.importObject)
			).instance;
		} catch {
			// Servers without the application/wasm MIME type.
			const bytes = await (
				await (options.fetch ?? fetch)(wasmUrl)
			).arrayBuffer();
			instance = (await WebAssembly.instantiate(bytes, go.importObject))
				.instance;
		}
		void go.run(instance);
		for (
			let attempt = 0;
			attempt < 100 && typeof utautts_plan !== "function";
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		if (typeof utautts_plan !== "function") {
			throw new Error("utautts_plan failed to initialize in global scope.");
		}
	}

	static get ready(): boolean {
		return typeof utautts_plan === "function";
	}

	/** Parse and cache a prosody model (e.g. `frame-intonation-v8.json`) inside the wasm. */
	static setModel(modelJSON: string): string | null {
		UtauTTSAdapter.assertReady();
		const result = utautts_set_model(modelJSON);
		if (!result.success)
			throw new Error(`UtauTTS model error: ${result.error}`);
		UtauTTSAdapter.modelId = result.id ?? null;
		return UtauTTSAdapter.modelId;
	}

	static get currentModelId(): string | null {
		return UtauTTSAdapter.modelId;
	}

	private static assertReady(): void {
		if (typeof utautts_plan !== "function") {
			throw new Error(
				"UtauTTS wasm is not initialized; call UtauTTSAdapter.initializeWasm() first.",
			);
		}
	}

	/**
	 * Register a koe voice bank with the planner: the manifest becomes a virtual
	 * oto.ini (koe PCM is pre-trimmed, so offset is 0) plus each sample's
	 * recorded pitch. Called automatically by {@link plan}; cheap when unchanged.
	 */
	setBank(bank: VoiceBank): void {
		UtauTTSAdapter.assertReady();
		if (this.currentBank === bank && this.bankAliases.has(bank)) return;
		const entries: Record<string, unknown[]> = {};
		const pitch: Record<string, number> = {};
		for (const [alias, phoneme] of Object.entries(bank.manifest.phonemes)) {
			entries[alias] = [
				{
					Filename: `koe:${alias}`,
					Alias: alias,
					Offset: 0,
					Fixed: phoneme.consonant / 48,
					Blank: 0,
					Preutterance: phoneme.pre / 48,
					Overlap: phoneme.overlap / 48,
					SourceGroup: "koe",
				},
			];
			if (phoneme.pitch > 0) pitch[alias] = phoneme.pitch;
		}
		const result = utautts_set_bank(
			JSON.stringify({
				name: "koe",
				oto_entries: entries,
				source_pitch_hz: pitch,
			}),
		);
		if (!result.success) throw new Error(`UtauTTS bank error: ${result.error}`);
		this.bankAliases.set(bank, result.aliases ?? 0);
		this.currentBank = bank;
		this.pcmCache.clear();
	}

	/**
	 * Plan an utterance: unit selection, timing, pitch contour and worldline
	 * placement. `features` are the mora-level frames from `openjtalkAnalyze`
	 * (pauses included); the kana reading is derived from them.
	 */
	plan(
		bank: VoiceBank,
		text: string,
		features: FeatureFrame[],
		options: UtauTTSOptions = {},
	): UtauTTSPlan {
		this.setBank(bank);
		const request = {
			text,
			reading: readingFromFeatures(features),
			frames: features.map((frame) => sparse_features(frame)),
			tone: options.tone ?? "C4",
			mora_duration_ms: options.moraDurationMs ?? 0,
			pause_duration_ms: options.pauseDurationMs ?? 0,
			release_ms: options.releaseMs ?? 20,
			leading_preutterance_ms: options.leadingPreutteranceMs ?? 0,
			apply_pitch: options.applyPitch ?? true,
			intonation_strength: options.intonationStrength ?? 1,
			speech_timing: options.speechTiming ?? false,
			word_boundary_envelope: options.wordBoundaryEnvelope ?? false,
			mora_durations_ms: options.prosody?.moraDurationsMs,
			pitch_curve: options.prosody?.pitchCurve,
		};
		const response = utautts_plan(JSON.stringify(request));
		if (!response.success || !response.plan) {
			throw new Error(`UtauTTS error: ${response.error ?? "no plan"}`);
		}
		const plan = JSON.parse(response.plan) as UtauTTSPlan;
		const gains = options.prosody?.moraGains;
		if (gains) applyMoraGains(plan, gains);
		return plan;
	}

	private getPcm(bank: VoiceBank, alias: string): Promise<Float64Array | null> {
		let cached = this.pcmCache.get(alias);
		if (!cached) {
			cached = bank.getPcm(alias);
			this.pcmCache.set(alias, cached);
		}
		return cached;
	}

	/**
	 * Render a plan chunk by chunk. Each chunk is independent audio positioned
	 * at `startMs`; schedule them as they arrive (see the demo) or sum them.
	 *
	 * Chunk breaks fall on pauses when possible. Inside a phrase a break renders
	 * one neighbouring unit of context on each side so the unit crossfade stays
	 * WORLD's spectral one, then the two renders are joined with a short
	 * equal-power crossfade in the following vowel.
	 */
	async *renderChunks(
		bank: VoiceBank,
		plan: UtauTTSPlan,
		options: UtauTTSRenderOptions = {},
	): AsyncGenerator<UtauTTSChunk> {
		const {
			firstChunkUnits = 3,
			chunkUnits = 6,
			seamCrossfadeMs = 20,
			signal,
		} = options;
		const timeline = plan.timeline;
		const units = timeline.units.filter((unit) => unit.length_ms > 0);
		const ranges = planChunks(
			units,
			Math.max(1, firstChunkUnits),
			Math.max(1, chunkUnits),
		);
		const crossfadeSamples = Math.max(2, msToSamples(seamCrossfadeMs));

		for (let index = 0; index < ranges.length; index++) {
			if (signal?.aborted) return;
			const range = ranges[index];
			const renderStart = range.headSeam ? range.start - 1 : range.start;
			const renderEnd = range.tailSeam ? range.end + 1 : range.end;
			const rendered = units.slice(renderStart, renderEnd);
			const baseMs = Math.min(...rendered.map((unit) => unit.position_ms));

			const phraseUnits: PhraseUnit[] = [];
			for (const unit of rendered) {
				const pcm = await this.getPcm(bank, unit.alias);
				if (!pcm || pcm.length < MIN_WORLDLINE_SAMPLES) {
					console.warn(
						`[utautts] no usable PCM for alias "${unit.alias}"; skipped`,
					);
					continue;
				}
				phraseUnits.push({
					pcm,
					posMs: unit.position_ms - baseMs,
					skipMs: unit.skip_ms,
					lengthMs: unit.length_ms,
					fadeInMs: unit.fade_in_ms,
					fadeOutMs: unit.fade_out_ms,
					consonantMs: unit.consonant_ms,
					requiredLengthMs: unit.required_length_ms,
					volume: unit.volume,
					tone: unit.tone,
				});
			}
			if (signal?.aborted) return;
			if (phraseUnits.length === 0) continue;

			const audio = this.worldline.renderPhrase({
				units: phraseUnits,
				pitch: (tMs) => f0At(timeline, baseMs + tMs),
				gender: options.gender,
				tension: options.tension,
				breathiness: options.breathiness,
				voicing: options.voicing,
			});
			if (!audio || audio.length === 0) continue;

			// Trim to [head seam − xf/2, tail seam + xf/2] and fade the seams.
			let fromSample = 0;
			let toSample = audio.length;
			let startMs = baseMs;
			if (range.headSeam) {
				const seamMs = seamTimeMs(units[range.start], seamCrossfadeMs);
				fromSample = Math.max(
					0,
					msToSamples(seamMs - baseMs) - crossfadeSamples / 2,
				);
				startMs = baseMs + (fromSample / FS) * 1000;
			}
			if (range.tailSeam) {
				const seamMs = seamTimeMs(units[range.end], seamCrossfadeMs);
				toSample = Math.min(
					audio.length,
					msToSamples(seamMs - baseMs) + crossfadeSamples / 2,
				);
			}
			if (toSample <= fromSample) continue;
			const pcm = audio.slice(fromSample, toSample);
			if (range.headSeam) applyFade(pcm, 0, crossfadeSamples, true);
			if (range.tailSeam)
				applyFade(
					pcm,
					Math.max(0, pcm.length - crossfadeSamples),
					crossfadeSamples,
					false,
				);

			yield { pcm, startMs, index, units: units.slice(range.start, range.end) };
			// Let the event loop breathe (audio scheduling, UI) between chunks.
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	/**
	 * Plan + render an utterance into one buffer (Float32, 48 kHz) covering the
	 * whole timeline. Use {@link plan} + {@link renderChunks} for streaming.
	 */
	async synthesizeText(
		bank: VoiceBank,
		text: string,
		features: FeatureFrame[],
		options: UtauTTSOptions & UtauTTSRenderOptions = {},
	): Promise<Float32Array | null> {
		const plan = this.plan(bank, text, features, options);
		const total = msToSamples(plan.timeline.duration_ms) + msToSamples(200);
		const out = new Float32Array(total);
		let any = false;
		for await (const chunk of this.renderChunks(bank, plan, options)) {
			any = true;
			const offset = msToSamples(chunk.startMs);
			const n = Math.min(chunk.pcm.length, out.length - offset);
			for (let k = 0; k < n; k++) out[offset + k] += chunk.pcm[k];
		}
		return any ? out : null;
	}
}
