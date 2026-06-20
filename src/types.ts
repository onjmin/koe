/**
 * One phoneme, already trimmed to its usable oto region.
 * Sample 0 corresponds to the oto `offset` (left blank); everything before it
 * in the source WAV has been removed during conversion. All positions below are
 * therefore relative to the trimmed sample start.
 */
export interface PhonemeEntry {
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

export interface Manifest {
	sampleRate: 48000;
	/** Reference pitch used when recording the voice bank (Hz) */
	referencePitch: number;
	phonemes: Record<string, PhonemeEntry>;
}

export interface NoteEvent {
	phoneme: string;
	/** Desired output pitch in Hz */
	pitch: number;
	/** Output duration in samples at 48kHz */
	duration: number;
}
