/**
 * One phoneme, already trimmed to its usable oto region.
 * Sample 0 corresponds to the oto `offset` (left blank); everything before it
 * in the source WAV has been removed during conversion. All positions below are
 * therefore relative to the trimmed sample start.
 */
interface PhonemeEntry {
    /** Byte offset of this phoneme's PCM within voice.bin */
    offset: number;
    /** Trimmed sample count = oto region [offset, cutoff] (48kHz / 16bit / mono) */
    length: number;
    /** Preutterance in samples (note onset alignment point) */
    pre: number;
    /** Overlap / crossfade length in samples */
    overlap: number;
    /** Consonant (fixed, non-looped) region length in samples */
    consonant: number;
    /**
     * Detected recorded fundamental frequency in Hz (0 if undetectable).
     * Playback resamples by `targetPitch / pitch`, so any source format
     * (multi-pitch, single-pitch with pitch-suffixed aliases, …) tunes correctly.
     */
    pitch: number;
}
interface Manifest {
    sampleRate: 48000;
    /** Reference pitch used when recording the voice bank (Hz) */
    referencePitch: number;
    phonemes: Record<string, PhonemeEntry>;
}
interface NoteEvent {
    phoneme: string;
    /** Desired output pitch in Hz */
    pitch: number;
    /** Output duration in samples at 48kHz */
    duration: number;
}

/**
 * Read-only access to a .koe voice bank: its manifest plus per-phoneme PCM,
 * fetched on demand (Blob slice or HTTP Range). The full bank is never held in
 * memory.
 *
 * Pure data — no AudioContext, no AudioWorklet, no DOM. Use this when you only
 * need the source samples (e.g. to feed the {@link Worldline} renderer or any
 * other vocoder). {@link KoeEngine} builds its concatenative playback on top of
 * this same class.
 *
 *   const bank = await VoiceBank.load(koeBlobOrUrl);
 *   const pcm  = await bank.getPcm('a');   // Float64 [-1, 1]
 */
declare class VoiceBank {
    /** The voice bank manifest (sample rate, reference pitch, phoneme table). */
    readonly manifest: Manifest;
    private source;
    private constructor();
    /**
     * Parse a .koe archive header + manifest and bind a lazy PCM source.
     * @param koe a Blob/File of the .koe archive, or a URL (served with Range support)
     */
    static load(koe: Blob | string): Promise<VoiceBank>;
    /** True if the bank contains a phoneme under this alias. */
    has(phoneme: string): boolean;
    /**
     * Raw Int16 PCM bytes (48 kHz / mono) for a phoneme, or null if unknown.
     * The returned ArrayBuffer is freshly allocated and safe to transfer to a
     * worker / AudioWorklet.
     */
    readPcmBytes(phoneme: string): Promise<ArrayBuffer | null>;
    /**
     * A phoneme's PCM as a Float64Array normalised to [-1, 1], or null if unknown.
     * Intended for external analysis / resynthesis such as the WORLD vocoder.
     */
    getPcm(phoneme: string): Promise<Float64Array | null>;
}

interface KoeEngineOptions {
    /** URL to koe-worklet.js. Defaults to './koe-worklet.js'. */
    workletUrl?: string;
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
declare class KoeEngine {
    private ctx;
    private workletUrl;
    private node;
    private bank;
    private delivered;
    private pending;
    constructor(options?: KoeEngineOptions);
    get audioContext(): AudioContext;
    get manifest(): Manifest | null;
    /** The underlying voice bank (manifest + on-demand PCM), or null before load(). */
    get voiceBank(): VoiceBank | null;
    /**
     * Register the worklet and bind a .koe voice bank.
     * @param koe a Blob/File of the .koe archive, or a URL (served with Range support)
     */
    load(koe: Blob | string): Promise<void>;
    /** Fetch one phoneme's PCM and deliver it to the worklet (deduped, cached). */
    private ensurePhoneme;
    /** Stop current playback, preload the phonemes for `notes`, then queue them. */
    play(notes: NoteEvent[]): Promise<void>;
    /** Stop playback and clear the queue. */
    stop(): void;
    /** Resume the AudioContext if suspended (e.g. after autoplay block). */
    resume(): Promise<void>;
    /**
     * Read a phoneme's raw PCM and return it as a Float64Array normalised to
     * [-1, 1]. Convenience that forwards to the underlying {@link VoiceBank}.
     * Intended for external analysis such as the WORLD vocoder.
     */
    getPcm(phoneme: string): Promise<Float64Array | null>;
}

/** Output sample rate of the worldline synthesizer. */
declare const WORLDLINE_SAMPLE_RATE = 48000;
/**
 * WORLD needs roughly 85 ms of audio for stable F0 analysis. Phonemes with
 * fewer samples than this are rejected (renderNote returns null).
 */
declare const MIN_WORLDLINE_SAMPLES = 4096;
/**
 * The subset of the Emscripten module surface that we call. worldline.js is an
 * MODULARIZE=1 / EXPORT_NAME=WorldlineModule build of OpenUtau's worldline.
 */
interface WorldlineWasm {
    _PhraseSynthNew(): number;
    _PhraseSynthDelete(ps: number): void;
    _PhraseSynthAddRequest(ps: number, req: number, posMs: number, skipMs: number, lengthMs: number, fadeInMs: number, fadeOutMs: number, flag: number): void;
    _PhraseSynthSetCurves(ps: number, f0: number, gender: number, tension: number, breathiness: number, voicing: number, length: number, frameMs: number): void;
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
    var WorldlineModule: WorldlineFactory | undefined;
}
interface WorldlineLoadOptions {
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
interface RenderNoteParams {
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
declare const samplesToMs: (samples: number) => number;
/**
 * Derive {@link RenderNoteParams} lead-in / consonant fields from a manifest
 * entry, so callers don't repeat the sample→ms conversion.
 *
 *   const params = { pcm, pitch, durationMs, ...leadInFromEntry(entry) };
 */
declare function leadInFromEntry(entry: PhonemeEntry): {
    preMs: number;
    consonantMs: number;
};
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
declare class Worldline {
    private wasm;
    readonly sampleRate = 48000;
    private constructor();
    /** Load + instantiate the worldline WASM module (deduped per scriptUrl). */
    static load(options: WorldlineLoadOptions): Promise<Worldline>;
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
    renderNote(params: RenderNoteParams): Float32Array | null;
}

interface OtoEntry {
    /** Source WAV filename */
    wav: string;
    /** Phoneme alias */
    alias: string;
    /** Left blank — offset from WAV start (ms) */
    offset: number;
    /** Consonant portion end from offset (ms) */
    consonant: number;
    /** Right blank — negative = from WAV end, positive = from offset (ms) */
    cutoff: number;
    /** Preutterance from offset (ms) */
    pre: number;
    /** Overlap / crossfade region (ms) */
    overlap: number;
}
/**
 * Parse oto.ini content (already decoded to UTF-8 string).
 * Silently skips malformed lines.
 */
declare function parseOto(content: string): OtoEntry[];

interface WavData {
    sampleRate: number;
    channels: number;
    /** Normalized samples in [-1, 1], interleaved if multi-channel */
    samples: Float32Array;
}
/** Parse a WAV file from an ArrayBuffer. Supports PCM 8/16/24-bit and IEEE float 32-bit. */
declare function parseWav(buf: ArrayBuffer): WavData;
/** Mix down to mono by averaging all channels. */
declare function toMono(wav: WavData): WavData;
/** Linear interpolation resample to targetRate. Expects mono input. */
declare function resample(wav: WavData, targetRate: number): WavData;
/** Convert Float32 [-1,1] samples to Int16 PCM. */
declare function toInt16(samples: Float32Array): Int16Array;
/** Normalize then convert a WAV to 48kHz/16bit/mono Int16 PCM. */
declare function normalizePcm(buf: ArrayBuffer): Int16Array;

interface PackInput {
    oto: OtoEntry;
    /** Full normalized PCM of the source WAV (48kHz / 16bit / mono) */
    pcm: Int16Array;
    /** Known recorded pitch in Hz (e.g. from the .frq file). 0/undefined → auto-detect. */
    recordedPitch?: number;
}
interface PackOutput {
    manifest: Manifest;
    /** Raw PCM blob — Int16 / 48kHz / mono */
    bin: ArrayBuffer;
}
interface TrimmedPhoneme {
    /** PCM trimmed to the oto region [offset, cutoff] */
    pcm: Int16Array;
    /** Manifest params relative to the trimmed start (sample 0 = oto offset) */
    entry: Omit<PhonemeEntry, 'offset'>;
}
/**
 * Cut the full WAV PCM down to its usable oto region and recompute parameters
 * relative to the trimmed start.
 *
 * UTAU oto.ini values are all in ms and measured from `offset` (the left blank),
 * except `cutoff` (right blank):
 *   - cutoff >= 0 : measured from the END of the file
 *   - cutoff <  0 : region length from offset = |cutoff|
 *
 * After trimming, sample 0 == oto offset, so pre/overlap/consonant carry over
 * unchanged (just converted to samples), and the slice length is the region end.
 */
declare function trimToOto(pcm: Int16Array, oto: OtoEntry, recordedPitch?: number): TrimmedPhoneme;
/**
 * Pack normalized PCM phonemes into voice.bin + manifest.json.
 * Each phoneme is trimmed to its oto region first.
 * Duplicate aliases are silently overwritten by the later entry.
 */
declare function pack(inputs: PackInput[], referencePitch?: number): PackOutput;

/** Parse a note name like "E4", "G#4", "Db5" → frequency in Hz (null if invalid). */
declare function noteNameToHz(name: string): number | null;
/** Recorded pitch encoded in a multi-pitch alias suffix: "a い_E4" → 329.63 Hz. */
declare function pitchFromAliasSuffix(alias: string): number | null;
/**
 * Estimate the fundamental frequency (Hz) of a voiced region by normalized
 * autocorrelation. Returns 0 when no clear pitch is found (unvoiced consonant,
 * silence, or a region too short to analyse).
 *
 * The signal is decimated to a lower analysis rate for speed; f0 below ~700 Hz
 * is well within the resulting Nyquist limit. A parabolic interpolation around
 * the best lag gives sub-sample (sub-semitone) accuracy.
 */
declare function detectF0(pcm: Int16Array, start: number, end: number): number;

/**
 * UTAU `.frq` frequency-analysis files (FREQ0003). The same format OpenUtau
 * reads: an 8-byte header, hop size, then the average fundamental frequency of
 * the recording — exactly the reference pitch we need for correct resampling.
 *
 * Layout:
 *   char[8]  "FREQ0003"
 *   int32    hopSize
 *   float64  averageF0   ← the recorded pitch in Hz
 *   byte[16] (blank)
 *   int32    length
 *   { float64 f0, float64 amp } × length
 */
declare function parseFrqAverageF0(buffer: ArrayBuffer): number | null;
/** Map a WAV filename to its sibling frq filename: "あ.wav" → "あ_wav.frq". */
declare function frqFileName(wavName: string): string;

/**
 * Koe Archive Format (.koe)
 *   [4B] magic 'KOE\0' (big-endian)
 *   [4B] JSON length (little-endian)
 *   [N ] manifest JSON (UTF-8)
 *   [M ] raw PCM (Int16 / 48kHz / mono); phoneme offsets are relative to here
 */
declare function packKoe(manifest: Manifest, pcmParts: BlobPart[]): Blob;
/** Read the 8-byte header → JSON length. Throws on bad magic. */
declare function parseKoeHeader(headerBytes: ArrayBuffer): {
    jsonLength: number;
};
/** Byte offset where PCM data begins, given the JSON length. */
declare const pcmBase: (jsonLength: number) => number;

export { KoeEngine, type KoeEngineOptions, MIN_WORLDLINE_SAMPLES, type Manifest, type NoteEvent, type OtoEntry, type PackInput, type PackOutput, type PhonemeEntry, type RenderNoteParams, type TrimmedPhoneme, VoiceBank, WORLDLINE_SAMPLE_RATE, type WavData, Worldline, type WorldlineLoadOptions, detectF0, frqFileName, leadInFromEntry, normalizePcm, noteNameToHz, pack, packKoe, parseFrqAverageF0, parseKoeHeader, parseOto, parseWav, pcmBase, pitchFromAliasSuffix, resample, samplesToMs, toInt16, toMono, trimToOto };
