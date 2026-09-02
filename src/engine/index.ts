import type { Manifest, NoteEvent } from "../types.js";
import { VoiceBank } from "./voice-bank.js";

export type { NoteEvent };

export interface KoeEngineOptions {
	/** URL to koe-worklet.js. Defaults to './koe-worklet.js'. */
	workletUrl?: string;
}

export interface PlayOptions {
	/**
	 * Play the first note's lead-in (its consonant / preutterance region) instead
	 * of skipping straight to the vowel.
	 *
	 * Every note but the first gets its lead-in from the crossfade with the note
	 * before it. The first note has no predecessor, so the lead-in has to come
	 * from somewhere: with `leadIn` the phrase starts one preutterance EARLIER
	 * relative to its beats, and {@link KoeEngine.play} returns that offset in
	 * samples so a sequencer can schedule around it. Left off (the default), the
	 * first note keeps its beat exactly but opens on its vowel, dropping the
	 * consonant.
	 */
	leadIn?: boolean;
}

/**
 * Main-thread API for the koe concatenative synthesis engine.
 *
 * Loads a single .koe archive. The full voice bank is never held in memory:
 * phonemes are fetched on demand (via {@link VoiceBank}) and cached in the
 * audio thread.
 *
 *   const engine = new KoeEngine();
 *   await engine.load(koeBlobOrUrl);
 *   await engine.play([{ phoneme: 'a', pitch: 440, duration: 48000 }]);
 *
 * For analysis / resynthesis (e.g. {@link Worldline}) you usually only need the
 * raw samples — use {@link VoiceBank} directly instead, which needs no
 * AudioContext or worklet.
 */
export class KoeEngine {
	private ctx: AudioContext;
	private workletUrl: string;
	private node: AudioWorkletNode | null = null;
	private bank: VoiceBank | null = null;
	private delivered = new Set<string>();
	private pending = new Map<string, Promise<void>>();

	constructor(options: KoeEngineOptions = {}) {
		this.ctx = new AudioContext({ sampleRate: 48000 });
		this.workletUrl = options.workletUrl ?? "./koe-worklet.js";
	}

	get audioContext(): AudioContext {
		return this.ctx;
	}

	get manifest(): Manifest | null {
		return this.bank?.manifest ?? null;
	}

	/** The underlying voice bank (manifest + on-demand PCM), or null before load(). */
	get voiceBank(): VoiceBank | null {
		return this.bank;
	}

	/**
	 * Register the worklet and bind a .koe voice bank.
	 * @param koe a Blob/File of the .koe archive, or a URL (served with Range support)
	 */
	async load(koe: Blob | string): Promise<void> {
		await this.ctx.audioWorklet.addModule(this.workletUrl);

		// Re-loading: tear down the previous node, or both would keep playing.
		this.node?.disconnect();
		this.node = null;

		this.bank = await VoiceBank.load(koe);
		this.delivered.clear();
		this.pending.clear();

		this.node = new AudioWorkletNode(this.ctx, "koe-processor", {
			numberOfInputs: 0,
			numberOfOutputs: 1,
			outputChannelCount: [1],
		});
		this.node.port.postMessage({ type: "init", manifest: this.bank.manifest });
		this.node.connect(this.ctx.destination);

		console.log(
			"[koe] ready —",
			Object.keys(this.bank.manifest.phonemes).length,
			"phonemes (on-demand)",
		);
	}

	/** Fetch one phoneme's PCM and deliver it to the worklet (deduped, cached). */
	private ensurePhoneme(name: string): Promise<void> {
		if (this.delivered.has(name)) return Promise.resolve();
		const existing = this.pending.get(name);
		if (existing) return existing;
		if (!this.bank || !this.node) return Promise.resolve();

		const load = this.bank
			.readPcmBytes(name)
			.then((buf) => {
				if (!buf || !this.node) return;
				this.node.port.postMessage({ type: "phoneme", name, buffer: buf }, [
					buf,
				]);
				this.delivered.add(name);
			})
			.finally(() => {
				// Always clear pending — a failed fetch must stay retryable, or the
				// rejected promise would poison every later play() of this phoneme.
				this.pending.delete(name);
			});

		this.pending.set(name, load);
		return load;
	}

	/**
	 * Stop current playback, preload the phonemes for `notes`, then queue them.
	 *
	 * @returns the lead-in offset in samples — how far the first note's audio
	 *          starts ahead of its beat. 0 unless {@link PlayOptions.leadIn}.
	 */
	async play(notes: NoteEvent[], options: PlayOptions = {}): Promise<number> {
		if (!this.node) throw new Error("KoeEngine: call load() before play()");
		this.node.port.postMessage({ type: "stop" });
		const names = [...new Set(notes.map((n) => n.phoneme))].filter(Boolean);
		await Promise.all(names.map((n) => this.ensurePhoneme(n)));
		const leadIn = options.leadIn === true;
		this.node.port.postMessage({ type: "play", notes, leadIn });
		return leadIn ? this.leadInSamples(notes) : 0;
	}

	/**
	 * Output samples the first note's lead-in occupies ahead of its beat —
	 * mirrors what the worklet does with `leadIn`, so callers can compensate.
	 */
	private leadInSamples(notes: NoteEvent[]): number {
		const first = notes[0];
		const m = this.bank?.manifest;
		if (!first || !m || first.phoneme === "") return 0;
		const entry = Object.hasOwn(m.phonemes, first.phoneme)
			? m.phonemes[first.phoneme]
			: undefined;
		if (!entry || entry.length <= 0) return 0;
		const recorded = entry.pitch || m.referencePitch || first.pitch || 1;
		const stepRate = first.pitch / recorded;
		return stepRate > 0 ? entry.pre / stepRate : 0;
	}

	/** Stop playback and clear the queue. */
	stop(): void {
		this.node?.port.postMessage({ type: "stop" });
	}

	/** Resume the AudioContext if suspended (e.g. after autoplay block). */
	async resume(): Promise<void> {
		if (this.ctx.state === "suspended") await this.ctx.resume();
	}

	/**
	 * Tear down the worklet node and close the AudioContext, releasing the audio
	 * hardware. The engine cannot be reused afterwards — create a new one.
	 */
	async dispose(): Promise<void> {
		this.node?.disconnect();
		this.node = null;
		this.bank = null;
		this.delivered.clear();
		this.pending.clear();
		if (this.ctx.state !== "closed") await this.ctx.close();
	}

	/**
	 * Read a phoneme's raw PCM and return it as a Float64Array normalised to
	 * [-1, 1]. Convenience that forwards to the underlying {@link VoiceBank}.
	 * Intended for external analysis such as the WORLD vocoder.
	 */
	async getPcm(phoneme: string): Promise<Float64Array | null> {
		return this.bank?.getPcm(phoneme) ?? null;
	}
}
