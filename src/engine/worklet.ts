/**
 * AudioWorkletProcessor — runs inside the audio thread.
 * Loaded via AudioContext.audioWorklet.addModule().
 *
 * The full voice.bin is NEVER loaded here (it can be gigabytes). Instead the
 * main thread streams individual phoneme PCM slices on demand; this processor
 * caches them by name and plays from the per-phoneme buffers.
 *
 * Messages from the main thread:
 *   { type: 'init',    manifest: Manifest }
 *   { type: 'phoneme', name: string, buffer: ArrayBuffer }  // Int16 PCM for one phoneme
 *   { type: 'play',    notes: NoteEvent[] }
 *   { type: 'stop' }
 */

// Minimal type declarations for the AudioWorklet global scope.
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
	constructor(options?: unknown);
}
declare function registerProcessor(
	name: string,
	ctor: typeof AudioWorkletProcessor,
): void;

interface PhonemeEntry {
	offset: number;
	length: number;
	pre: number;
	overlap: number;
	consonant: number;
	/** Recorded fundamental frequency in Hz (0 if undetectable) */
	pitch: number;
}

interface Manifest {
	sampleRate: 48000;
	referencePitch: number;
	phonemes: Record<string, PhonemeEntry>;
}

interface NoteEvent {
	phoneme: string;
	pitch: number;
	duration: number;
}

/** Minimum crossfade between consecutive notes (~10 ms at 48 kHz) to avoid clicks. */
const MIN_CROSSFADE = 480;

/** Shared empty buffer for rest notes (phoneme === ''). */
const SILENT = new Int16Array(0);

interface ActiveNote {
	/** This phoneme's own PCM buffer (trimmed: sample 0 = oto offset) */
	data: Int16Array;
	/** Total trimmed length in samples */
	length: number;
	/** Consonant region length — looped sustain starts here */
	consonant: number;
	/**
	 * Preutterance in samples. The region [0, pre] is the lead-in (e.g. the
	 * trailing vowel + consonant of a VCV sample like "い あ"). It plays BEFORE
	 * this note's beat, overlapping the previous note. The note's own sound (the
	 * target vowel) begins at `pre`.
	 */
	pre: number;
	/** Overlap / crossfade length in samples (within the lead-in region) */
	overlap: number;
	/** Current fractional read position within `data` */
	readPos: number;
	/** Samples to advance readPos per output sample (pitch ratio) */
	stepRate: number;
	/** Output samples remaining in this note's beat */
	remaining: number;
}

class KoeProcessor extends AudioWorkletProcessor {
	private manifest: Manifest | null = null;
	/** Per-phoneme PCM cache, keyed by alias */
	private phonemes = new Map<string, Int16Array>();
	private queue: NoteEvent[] = [];
	private current: ActiveNote | null = null;
	private next: ActiveNote | null = null;

	constructor(options?: unknown) {
		super(options);
		this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data);
	}

	private onMessage(msg: {
		type: string;
		manifest?: Manifest;
		name?: string;
		buffer?: ArrayBuffer;
		notes?: NoteEvent[];
	}) {
		if (msg.type === "init" && msg.manifest) {
			this.manifest = msg.manifest;
		} else if (msg.type === "phoneme" && msg.name && msg.buffer) {
			this.phonemes.set(msg.name, new Int16Array(msg.buffer));
		} else if (msg.type === "play" && msg.notes) {
			this.queue.push(...msg.notes);
		} else if (msg.type === "stop") {
			this.queue = [];
			this.current = null;
			this.next = null;
		}
	}

	private dequeue(): ActiveNote | null {
		const note = this.queue.shift();
		if (!note || !this.manifest) return null;

		// Rest: a timed stretch of silence
		if (note.phoneme === "") {
			return {
				data: SILENT,
				length: 0,
				consonant: 0,
				pre: 0,
				overlap: 0,
				readPos: 0,
				stepRate: 1,
				remaining: note.duration,
			};
		}

		const entry = this.manifest.phonemes[note.phoneme];
		const data = this.phonemes.get(note.phoneme);
		// Skip notes whose PCM hasn't been delivered yet
		if (!entry || !data) return null;

		// Resample from this sample's own recorded pitch, falling back to the
		// bank-wide reference pitch when detection failed.
		const recorded = entry.pitch || this.manifest.referencePitch;

		return {
			data,
			length: entry.length,
			consonant: entry.consonant,
			pre: entry.pre,
			overlap: entry.overlap,
			readPos: 0,
			stepRate: note.pitch / recorded,
			remaining: note.duration,
		};
	}

	/** Linear interpolation read from a phoneme buffer at a fractional index. */
	private readSample(data: Int16Array, idx: number): number {
		const i = idx | 0;
		const frac = idx - i;
		return (
			((data[i] ?? 0) + ((data[i + 1] ?? 0) - (data[i] ?? 0)) * frac) / 32768
		);
	}

	/**
	 * Advance a note's read position by one output sample.
	 * Plays the consonant once, then loops the sustain region [consonant, length)
	 * so notes longer than the sample keep sounding.
	 */
	private advance(n: ActiveNote): void {
		if (n.length <= 0) return; // rest — nothing to advance
		n.readPos += n.stepRate;
		if (n.readPos >= n.length) {
			const sustain = n.length - n.consonant;
			n.readPos =
				sustain > 0
					? n.consonant + ((n.readPos - n.consonant) % sustain)
					: n.length - 1;
		}
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const out = outputs[0]?.[0];
		if (!out) return true;

		for (let i = 0; i < out.length; i++) {
			// Rotate notes
			if (!this.current || this.current.remaining <= 0) {
				const fromNext = this.next !== null;
				this.current = this.next ?? this.dequeue();
				this.next = null;
				if (!this.current) {
					out[i] = 0;
					continue;
				}
				// A fresh note (no previous note feeding its lead-in) skips straight to
				// its target vowel. A note promoted from `next` has already played its
				// lead-in during the crossfade, so it continues from where it is.
				if (!fromNext) this.current.readPos = this.current.pre;
			}

			const cur = this.current;

			// Prefetch the next note (idle until its lead-in window begins)
			if (!this.next && this.queue.length > 0) {
				this.next = this.dequeue();
			}

			let sample = this.readSample(cur.data, cur.readPos);

			// Tail fade-out when this is the last active note — prevents clicks on single phonemes.
			if (
				!this.next &&
				this.queue.length === 0 &&
				cur.remaining <= MIN_CROSSFADE &&
				cur.length > 0
			) {
				sample *= cur.remaining / MIN_CROSSFADE;
			}

			// Lead-in / crossfade: the next note's preutterance aligns to the beat
			// boundary (cur.remaining == 0). So we start the next note `pre` samples
			// early, overlapping the tail of the current note. The first `overlap`
			// samples crossfade; after that the current note is faded out.
			if (this.next) {
				const nxt = this.next;
				// pre/overlap are in source samples; convert to output samples so the
				// next note advances exactly `pre` source samples during the window and
				// its vowel onset lands on the beat regardless of pitch shift.
				const lead = Math.max(nxt.pre / nxt.stepRate, MIN_CROSSFADE);
				if (cur.remaining <= lead) {
					const xfade = Math.min(
						Math.max(nxt.overlap / nxt.stepRate, MIN_CROSSFADE),
						lead,
					);
					const into = lead - cur.remaining; // 0 → lead
					const g = Math.min(1, into / xfade); // fade-in gain
					const nextSample = this.readSample(nxt.data, nxt.readPos);
					sample = sample * (1 - g) + nextSample * g;
					this.advance(nxt);
				}
			}

			out[i] = sample;
			this.advance(cur);
			cur.remaining--;
		}

		return true;
	}
}

registerProcessor("koe-processor", KoeProcessor);
