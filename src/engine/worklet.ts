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
 *   { type: 'play',    notes: NoteEvent[], leadIn?: boolean }
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
/** Sample rate of the rendering context, exposed by AudioWorkletGlobalScope. */
declare const sampleRate: number;

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

/**
 * A note may surrender at most half of itself to the next note's lead-in.
 * See {@link KoeProcessor.prepareTransition}.
 */
const LEAD_BUDGET = 0.5;

/** Cost caps for the phase-alignment search (per note transition, one-shot). */
const ALIGN_MAX_TAPS = 256;
const ALIGN_COARSE_LAGS = 64;
/** Below this crossfade length, aligning is not worth the correlation. */
const ALIGN_MIN_XFADE = 32;

/** Shared empty buffer for rest notes (phoneme === ''). */
const SILENT = new Int16Array(0);

/** Sustain-loop seam geometry — depends only on the buffer, so it is cached. */
interface LoopPoints {
	/** Source index the loop returns to, phase-aligned with the seam */
	start: number;
	/** Seam crossfade length in source samples (0 = hard wrap) */
	fade: number;
}

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
	/** This note's full beat length in output samples (fixed at dequeue) */
	duration: number;
	/** Output samples per fundamental period at the TARGET pitch */
	period: number;
	/**
	 * Lead-in length in OUTPUT samples, after preutterance correction. Set by
	 * {@link KoeProcessor.prepareTransition} when this note is prefetched.
	 */
	lead: number;
	/** Crossfade length in OUTPUT samples (<= lead) */
	xfade: number;
	/** Sustain loop seam, resolved on first use of this phoneme */
	loop: LoopPoints;
	/** Head fade-in length in output samples (0 = none) */
	fadeIn: number;
	/** True once this note's entry crossfade has been phase-aligned */
	aligned: boolean;
}

class KoeProcessor extends AudioWorkletProcessor {
	private manifest: Manifest | null = null;
	/** Per-phoneme PCM cache, keyed by alias */
	private phonemes = new Map<string, Int16Array>();
	/** Per-phoneme sustain loop seam, keyed by alias */
	private loops = new Map<string, LoopPoints>();
	private queue: NoteEvent[] = [];
	private current: ActiveNote | null = null;
	private next: ActiveNote | null = null;
	/** Play the first note's lead-in instead of skipping to its vowel */
	private leadIn = false;
	/** Correlation window scratch — preallocated, never resized in `process`. */
	private scratch = new Float32Array(ALIGN_MAX_TAPS);

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
		leadIn?: boolean;
	}) {
		if (msg.type === "init" && msg.manifest) {
			this.manifest = msg.manifest;
		} else if (msg.type === "phoneme" && msg.name && msg.buffer) {
			// Floor to whole samples — Int16Array(buffer) throws on odd byte counts.
			this.phonemes.set(
				msg.name,
				new Int16Array(msg.buffer, 0, Math.floor(msg.buffer.byteLength / 2)),
			);
			this.loops.delete(msg.name); // buffer replaced — reanalyse the seam
		} else if (msg.type === "play" && msg.notes) {
			this.leadIn = msg.leadIn === true;
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
				duration: note.duration,
				period: 0,
				lead: 0,
				xfade: 0,
				loop: { start: 0, fade: 0 },
				fadeIn: 0,
				aligned: true,
			};
		}

		// Own-property check: a plain [phoneme] access would also match inherited
		// Object.prototype keys like "toString" / "constructor".
		const entry = Object.hasOwn(this.manifest.phonemes, note.phoneme)
			? this.manifest.phonemes[note.phoneme]
			: undefined;
		const data = this.phonemes.get(note.phoneme);
		// Skip notes whose PCM hasn't been delivered yet
		if (!entry || !data) return null;

		// Resample from this sample's own recorded pitch, falling back to the
		// bank-wide reference pitch when detection failed. The last fallback to the
		// target pitch (stepRate 1) keeps a bank carrying no pitch data at all from
		// producing a non-finite step.
		const recorded =
			entry.pitch || this.manifest.referencePitch || note.pitch || 1;

		return {
			data,
			length: entry.length,
			consonant: entry.consonant,
			pre: entry.pre,
			overlap: entry.overlap,
			readPos: 0,
			stepRate: note.pitch / recorded,
			remaining: note.duration,
			duration: note.duration,
			period: note.pitch > 0 ? sampleRate / note.pitch : 0,
			lead: 0,
			xfade: 0,
			loop: this.loopPoints(
				note.phoneme,
				data,
				entry.length,
				entry.consonant,
				sampleRate / recorded,
			),
			fadeIn: 0,
			aligned: false,
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
	 * Read one output sample from a note, crossfading the sustain-loop seam.
	 *
	 * A hard wrap from `length` back into the sustain lands on an arbitrary
	 * phase, so a long note clicks once per loop. Fading the tail into the
	 * (phase-aligned) loop head removes the step.
	 */
	private read(n: ActiveNote): number {
		const s = this.readSample(n.data, n.readPos);
		const fade = n.loop.fade;
		if (fade <= 0) return s;
		const seam = n.length - fade;
		if (n.readPos < seam) return s;
		const t = (n.readPos - seam) / fade; // 0 → 1 across the seam
		const head = this.readSample(n.data, n.loop.start + (n.readPos - seam));
		return s * (1 - t) + head * t;
	}

	/** Where a note's read head lands once it runs past `length`. */
	private wrap(n: ActiveNote, pos: number): number {
		const fade = n.loop.fade;
		const span =
			fade > 0 ? n.length - fade - n.loop.start : n.length - n.consonant;
		if (span <= 0) return n.length - 1;
		const base = fade > 0 ? n.loop.start + fade : n.consonant;
		return base + ((pos - n.length) % span);
	}

	/**
	 * Advance a note's read position by one output sample.
	 * Plays the consonant once, then loops the sustain region so notes longer
	 * than the sample keep sounding. With a seam crossfade the loop returns to
	 * `loop.start + loop.fade`, since the fade has already walked the head.
	 */
	private advance(n: ActiveNote): void {
		if (n.length <= 0) return; // rest — nothing to advance
		n.readPos += n.stepRate;
		if (n.readPos >= n.length) n.readPos = this.wrap(n, n.readPos);
	}

	/**
	 * Lag (in B's source samples) that best aligns stream B with stream A.
	 *
	 * This is the one-shot equivalent of UTAU's "crossfade optimisation". UTAU
	 * has to iterate because it nudges STP, which moves the analysis window,
	 * which changes the estimated pitch, which moves the phase again — a loop
	 * that is slow and can fail to converge. Here both streams are already
	 * resampled to exactly the same target f0 and both read positions are known
	 * exactly, so there is no feedback: measure once, shift once, done. And
	 * because neither rate changes during the window, an alignment made at the
	 * start still holds at the end of the crossfade.
	 *
	 * Scored by correlation normalised against B's window energy, so a loud lag
	 * cannot win on level alone.
	 */
	private bestLag(
		a: Int16Array,
		aPos: number,
		aStep: number,
		b: Int16Array,
		bPos: number,
		bStep: number,
		taps: number,
		lagMin: number,
		lagMax: number,
		lagStep: number,
	): number {
		const buf = this.scratch;
		let energyA = 0;
		for (let k = 0; k < taps; k++) {
			const v = this.readSample(a, aPos + k * aStep);
			buf[k] = v;
			energyA += v * v;
		}
		if (energyA <= 0) return 0;

		let best = 0;
		let bestScore = -Infinity;
		for (let lag = lagMin; lag <= lagMax; lag += lagStep) {
			let r = 0;
			let e = 0;
			for (let k = 0; k < taps; k++) {
				const v = this.readSample(b, bPos + lag + k * bStep);
				r += buf[k] * v;
				e += v * v;
			}
			if (e <= 0) continue;
			const score = r / Math.sqrt(e);
			// Ties go to the smaller shift, so a flat correlation (silence, DC, a
			// pure tone at the search period) leaves the timing where it was.
			if (
				score > bestScore ||
				(score === bestScore && Math.abs(lag) < Math.abs(best))
			) {
				bestScore = score;
				best = lag;
			}
		}
		return best;
	}

	/**
	 * Resolve (and cache) a phoneme's sustain-loop seam.
	 *
	 * The seam is picked so the loop head is in phase with the tail it replaces —
	 * the same correction the note-to-note crossfade needs. It depends only on
	 * the buffer and the RECORDED pitch, not on the note being sung, so it is
	 * computed once per phoneme.
	 */
	private loopPoints(
		name: string,
		data: Int16Array,
		length: number,
		consonant: number,
		srcPeriod: number,
	): LoopPoints {
		const cached = this.loops.get(name);
		if (cached) return cached;

		let points: LoopPoints = { start: consonant, fade: 0 };
		const sustain = length - consonant;
		// Need room for the fade plus a period of search and still leave a loop
		// body behind; below that a hard wrap is the lesser evil.
		if (sustain > 8 && srcPeriod >= 4 && Number.isFinite(srcPeriod)) {
			const fade = Math.min(MIN_CROSSFADE, Math.floor(sustain / 4));
			const seam = length - fade;
			const span = Math.min(
				Math.round(srcPeriod),
				Math.max(0, sustain - fade * 2 - 1),
			);
			let start = consonant;
			if (span > 0) {
				const taps = Math.min(fade, ALIGN_MAX_TAPS);
				const coarse = Math.max(1, Math.round(span / ALIGN_COARSE_LAGS));
				let lag = this.bestLag(
					data,
					seam,
					1,
					data,
					consonant,
					1,
					taps,
					0,
					span,
					coarse,
				);
				if (coarse > 1) {
					lag = this.bestLag(
						data,
						seam,
						1,
						data,
						consonant,
						1,
						taps,
						Math.max(0, lag - coarse),
						Math.min(span, lag + coarse),
						1,
					);
				}
				start = consonant + lag;
			}
			if (start + fade < length) points = { start, fade };
		}

		this.loops.set(name, points);
		return points;
	}

	/**
	 * Work out the lead-in geometry for `nxt` following `cur`, once, when `nxt`
	 * is prefetched.
	 *
	 * UTAU's preutterance correction: a note cannot give up more than half of
	 * itself to its successor's lead-in. Without it, a note shorter than the next
	 * note's preutterance is already past the end of the crossfade when its own
	 * beat arrives — the rotation then lands mid-fade and steps straight from one
	 * waveform to the other (measured at 0.75 full scale) while the note itself
	 * never sounds, and the one after it starts short of its vowel.
	 *
	 * Shortening the lead-in trims the head of the sample rather than stretching
	 * it, so the vowel onset still lands exactly on the beat.
	 */
	private prepareTransition(cur: ActiveNote, nxt: ActiveNote): void {
		const budget = Math.max(0, cur.remaining * LEAD_BUDGET);
		const minFade = Math.min(MIN_CROSSFADE, budget);

		// pre/overlap are in source samples; convert to output samples so the next
		// note advances exactly `pre` source samples during the window and its
		// vowel onset lands on the beat regardless of pitch shift.
		let lead = Math.max(nxt.pre / nxt.stepRate, minFade);
		// A note following silence has no tail to blend with, so the fade is only
		// there to avoid a click — keep it short rather than easing the consonant
		// in over the whole overlap.
		const wanted =
			cur.length > 0 ? Math.max(nxt.overlap / nxt.stepRate, minFade) : minFade;
		let xfade = Math.min(wanted, lead);

		if (lead > budget && lead > 0) {
			const scale = budget / lead;
			lead *= scale;
			xfade *= scale;
		}

		nxt.lead = lead;
		nxt.xfade = xfade;
		// Trim the head by whatever the lead-in cannot cover, so `pre` source
		// samples still elapse by the beat. When the MIN_CROSSFADE floor makes the
		// window longer than `pre`, start at 0 and accept an onset up to 10 ms early.
		nxt.readPos = Math.max(0, nxt.pre - lead * nxt.stepRate);
		nxt.aligned = false;
	}

	/**
	 * Phase-align the incoming note against the outgoing one, at the moment the
	 * crossfade window opens.
	 *
	 * Both streams are resampled to the same f0, so they are coherent: their
	 * relative phase decides whether the overlap adds or cancels. Left alone it
	 * is effectively random — set by how long the outgoing note happened to be —
	 * and the same two samples measure anywhere from −0.1 dB to −7 dB through the
	 * crossfade. Shifting the incoming read head by up to half a period (≤ ~2 ms
	 * at 233 Hz) costs nothing audible and flattens it.
	 *
	 * This is also why the fade stays linear in amplitude: once the streams are
	 * in phase they add coherently, so a linear fade is level-preserving, whereas
	 * an equal-power one would bulge by +3 dB in the middle.
	 */
	private alignPhase(cur: ActiveNote, nxt: ActiveNote): void {
		nxt.aligned = true;
		if (
			cur.length <= 0 ||
			nxt.length <= 0 ||
			nxt.period < 4 ||
			nxt.xfade < ALIGN_MIN_XFADE
		) {
			return;
		}

		const taps = Math.min(
			Math.round(nxt.period),
			Math.round(nxt.xfade),
			ALIGN_MAX_TAPS,
		);
		if (taps < 8) return;

		// Search half a period either way, in the incoming note's source samples,
		// so the onset moves by less than half a cycle whatever the answer is.
		const span = (nxt.period / 2) * nxt.stepRate;
		const coarse = Math.max(1, Math.round((2 * span) / ALIGN_COARSE_LAGS));
		let lag = this.bestLag(
			cur.data,
			cur.readPos,
			cur.stepRate,
			nxt.data,
			nxt.readPos,
			nxt.stepRate,
			taps,
			-span,
			span,
			coarse,
		);
		if (coarse > 1) {
			lag = this.bestLag(
				cur.data,
				cur.readPos,
				cur.stepRate,
				nxt.data,
				nxt.readPos,
				nxt.stepRate,
				taps,
				lag - coarse,
				lag + coarse,
				1,
			);
		}

		// A backward shift must not read before the start of the buffer; one whole
		// period forward is the same phase.
		const shifted = nxt.readPos + lag;
		nxt.readPos = shifted >= 0 ? shifted : shifted + nxt.period * nxt.stepRate;
		if (nxt.readPos < 0) nxt.readPos = 0;
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
				// A note promoted from `next` has already played its lead-in during the
				// crossfade, so it continues from where it is. A fresh note has no
				// previous note to feed it: either play the lead-in anyway (leadIn —
				// keeps the consonant, and the caller has budgeted the extra time) or
				// skip to the target vowel to keep the beat. Either way it opens on an
				// arbitrary point of the waveform, so it needs a fade-in of its own.
				if (!fromNext) {
					const fresh = this.current;
					if (this.leadIn && fresh.length > 0) {
						const offset = fresh.pre / fresh.stepRate;
						fresh.readPos = 0;
						fresh.remaining += offset;
						fresh.duration += offset;
					} else {
						fresh.readPos = fresh.pre;
					}
					fresh.fadeIn = Math.min(MIN_CROSSFADE, fresh.duration);
				}
			}

			const cur = this.current;

			// Prefetch the next note (idle until its lead-in window begins)
			if (!this.next && this.queue.length > 0) {
				this.next = this.dequeue();
				if (this.next) this.prepareTransition(cur, this.next);
			}

			let sample = this.read(cur);

			// Head fade-in — there was no previous note to fade this one in.
			if (cur.fadeIn > 0) {
				const done = cur.duration - cur.remaining;
				if (done < cur.fadeIn) sample *= done / cur.fadeIn;
				else cur.fadeIn = 0;
			}

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
			// boundary (cur.remaining == 0). So we start the next note `lead` samples
			// early, overlapping the tail of the current note. The first `xfade`
			// samples crossfade; after that the current note has fully faded out, so
			// the rotation itself is a no-op in the signal.
			if (this.next) {
				const nxt = this.next;
				if (cur.remaining <= nxt.lead) {
					if (!nxt.aligned) this.alignPhase(cur, nxt);
					const into = nxt.lead - cur.remaining; // 0 → lead
					const g = nxt.xfade > 0 ? Math.min(1, into / nxt.xfade) : 1;
					const nextSample = this.read(nxt);
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
