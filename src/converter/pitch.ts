const SAMPLE_RATE = 48000;

const NAME_SEMITONE: Record<string, number> = {
	c: 0,
	d: 2,
	e: 4,
	f: 5,
	g: 7,
	a: 9,
	b: 11,
};

/** Parse a note name like "E4", "G#4", "Db5" → frequency in Hz (null if invalid). */
export function noteNameToHz(name: string): number | null {
	const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name);
	if (!m) return null;
	let semi = NAME_SEMITONE[m[1].toLowerCase()];
	if (m[2] === "#") semi++;
	else if (m[2] === "b") semi--;
	const midi = (parseInt(m[3], 10) + 1) * 12 + semi;
	return 440 * 2 ** ((midi - 69) / 12);
}

/** Recorded pitch encoded in a multi-pitch alias suffix: "a い_E4" → 329.63 Hz. */
export function pitchFromAliasSuffix(alias: string): number | null {
	const m = /_([A-Ga-g][#b]?-?\d+)$/.exec(alias);
	return m ? noteNameToHz(m[1]) : null;
}

/**
 * Estimate the fundamental frequency (Hz) of a voiced region by normalized
 * autocorrelation. Returns 0 when no clear pitch is found (unvoiced consonant,
 * silence, or a region too short to analyse).
 *
 * The signal is decimated to a lower analysis rate for speed; f0 below ~700 Hz
 * is well within the resulting Nyquist limit. A parabolic interpolation around
 * the best lag gives sub-sample (sub-semitone) accuracy.
 */
export function detectF0(pcm: Int16Array, start: number, end: number): number {
	const DECIM = 4;
	const sr = SAMPLE_RATE / DECIM; // 12 kHz analysis rate
	const minLag = Math.floor(sr / 700); // highest f0 we look for
	const maxLag = Math.floor(sr / 70); // lowest f0 we look for

	const outLen = Math.floor((end - start) / DECIM);
	if (outLen < maxLag + 2) return 0;
	const win = Math.min(outLen, 1500); // up to ~0.125 s of vowel

	// Decimate (box-average) + remove DC, and build a prefix sum of squares so
	// each lag's window energy is O(1).
	const buf = new Float32Array(win);
	let mean = 0;
	for (let i = 0; i < win; i++) {
		let s = 0;
		const base = start + i * DECIM;
		for (let j = 0; j < DECIM; j++) s += pcm[base + j];
		buf[i] = s;
		mean += s;
	}
	mean /= win;

	const sq = new Float64Array(win + 1);
	for (let i = 0; i < win; i++) {
		buf[i] -= mean;
		sq[i + 1] = sq[i] + buf[i] * buf[i];
	}
	if (sq[win] < 1) return 0; // effectively silent

	// Normalized autocorrelation: 2·r(lag) / (E[0..n] + E[lag..lag+n]) ∈ [-1, 1].
	const norm = (lag: number): number => {
		const n = win - lag;
		let r = 0;
		for (let i = 0; i < n; i++) r += buf[i] * buf[i + lag];
		const e = sq[n] + (sq[lag + n] - sq[lag]);
		return e > 0 ? (2 * r) / e : 0;
	};

	let bestLag = -1;
	let best = 0;
	for (let lag = minLag; lag <= maxLag; lag++) {
		const v = norm(lag);
		if (v > best) {
			best = v;
			bestLag = lag;
		}
	}
	if (bestLag < 1 || best < 0.4) return 0; // unvoiced / no clear period

	// Parabolic interpolation around the peak
	const y0 = norm(bestLag - 1);
	const y1 = best;
	const y2 = norm(bestLag + 1);
	const denom = y0 - 2 * y1 + y2;
	const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;

	return sr / (bestLag + shift);
}
