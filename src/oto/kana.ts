/**
 * Kana → phoneme tables for oto.ini generation.
 *
 * A UTAU recording's filename *is* its phonetic transcript: `か.wav` holds one
 * mora, `_ああいあうえあ.wav` holds seven. Everything the estimator does — where
 * to look for the vowel, how wide to make the crossfade, whether the overlap
 * goes negative — follows from which consonant a mora starts with, so the kana
 * has to be resolved into (consonant, vowel) before any audio is touched.
 */

/**
 * Articulation class of a mora's initial consonant. The estimator branches on
 * this to pick where the preutterance lands and what overlap the mora gets;
 * see `ARTICULATION` in `estimate.ts`.
 */
export type ConsonantClass =
	/** あ/い/う/え/お — no consonant at all. */
	| "vowel"
	/** ん — a syllabic nasal that is its own nucleus. */
	| "nasalN"
	/** な/ま行 — voiced throughout, vowel starts at the nasal release. */
	| "nasal"
	/** ら行 — a flap: brief closure, then the vowel. */
	| "liquid"
	/** や/わ行 and vowel glides (いぇ, うぉ) — barely a consonant at all. */
	| "semivowel"
	/** さ/は行 — voiceless noise, so voicing onset *is* the vowel onset. */
	| "fricativeVoiceless"
	/** ざ行, ヴ — voiced noise. */
	| "fricativeVoiced"
	/** つ/ち — a stop released into friction; behaves like a plosive. */
	| "affricate"
	/** か/た/ぱ行 — a silent closure precedes the burst. */
	| "plosiveVoiceless"
	/** が/だ/ば行 — may prevoice through the closure. */
	| "plosiveVoiced";

export interface Syllable {
	/** The kana as written, e.g. "きゃ". Used verbatim in the alias. */
	kana: string;
	/** Romanised onset, e.g. "ky". Empty for bare vowels and ん. */
	consonant: string;
	/** Romanised nucleus: a/i/u/e/o, or "n" for ん. */
	vowel: string;
	cls: ConsonantClass;
}

const CLASS_OF: Record<string, ConsonantClass> = {
	"": "vowel",
	k: "plosiveVoiceless",
	ky: "plosiveVoiceless",
	t: "plosiveVoiceless",
	ty: "plosiveVoiceless",
	p: "plosiveVoiceless",
	py: "plosiveVoiceless",
	g: "plosiveVoiced",
	gy: "plosiveVoiced",
	d: "plosiveVoiced",
	dy: "plosiveVoiced",
	b: "plosiveVoiced",
	by: "plosiveVoiced",
	s: "fricativeVoiceless",
	sh: "fricativeVoiceless",
	h: "fricativeVoiceless",
	hy: "fricativeVoiceless",
	f: "fricativeVoiceless",
	z: "fricativeVoiced",
	j: "fricativeVoiced",
	v: "fricativeVoiced",
	ts: "affricate",
	ch: "affricate",
	n: "nasal",
	ny: "nasal",
	m: "nasal",
	my: "nasal",
	r: "liquid",
	ry: "liquid",
	y: "semivowel",
	w: "semivowel",
};

/**
 * kana → "consonant vowel". A space-separated pair keeps the table readable;
 * a leading space means "no consonant".
 */
const KANA: Record<string, string> = {
	あ: " a",
	い: " i",
	う: " u",
	え: " e",
	お: " o",
	ん: " n",
	か: "k a",
	き: "k i",
	く: "k u",
	け: "k e",
	こ: "k o",
	が: "g a",
	ぎ: "g i",
	ぐ: "g u",
	げ: "g e",
	ご: "g o",
	さ: "s a",
	し: "sh i",
	す: "s u",
	せ: "s e",
	そ: "s o",
	ざ: "z a",
	じ: "j i",
	ず: "z u",
	ぜ: "z e",
	ぞ: "z o",
	た: "t a",
	ち: "ch i",
	つ: "ts u",
	て: "t e",
	と: "t o",
	だ: "d a",
	ぢ: "j i",
	づ: "z u",
	で: "d e",
	ど: "d o",
	な: "n a",
	に: "n i",
	ぬ: "n u",
	ね: "n e",
	の: "n o",
	は: "h a",
	ひ: "h i",
	ふ: "f u",
	へ: "h e",
	ほ: "h o",
	ば: "b a",
	び: "b i",
	ぶ: "b u",
	べ: "b e",
	ぼ: "b o",
	ぱ: "p a",
	ぴ: "p i",
	ぷ: "p u",
	ぺ: "p e",
	ぽ: "p o",
	ま: "m a",
	み: "m i",
	む: "m u",
	め: "m e",
	も: "m o",
	や: "y a",
	ゆ: "y u",
	よ: "y o",
	ら: "r a",
	り: "r i",
	る: "r u",
	れ: "r e",
	ろ: "r o",
	わ: "w a",
	ゐ: "w i",
	ゑ: "w e",
	を: "w o",
	ゔ: "v u",
};

/** Small kana that can only appear as the second half of a digraph. */
const SMALL: Record<string, string> = {
	ぁ: "a",
	ぃ: "i",
	ぅ: "u",
	ぇ: "e",
	ぉ: "o",
	ゃ: "a",
	ゅ: "u",
	ょ: "o",
	ゎ: "a",
};

/** Digraphs whose onset is not simply "base consonant + y". */
const DIGRAPH: Record<string, string> = {
	しゃ: "sh a",
	しゅ: "sh u",
	しょ: "sh o",
	しぇ: "sh e",
	じゃ: "j a",
	じゅ: "j u",
	じょ: "j o",
	じぇ: "j e",
	ちゃ: "ch a",
	ちゅ: "ch u",
	ちょ: "ch o",
	ちぇ: "ch e",
	ぢゃ: "j a",
	ぢゅ: "j u",
	ぢょ: "j o",
	つぁ: "ts a",
	つぃ: "ts i",
	つぇ: "ts e",
	つぉ: "ts o",
	てぃ: "t i",
	てゃ: "ty a",
	てゅ: "ty u",
	てょ: "ty o",
	でぃ: "d i",
	でゃ: "dy a",
	でゅ: "dy u",
	でょ: "dy o",
	とぅ: "t u",
	どぅ: "d u",
	ふぁ: "f a",
	ふぃ: "f i",
	ふぇ: "f e",
	ふぉ: "f o",
	ふゅ: "f u",
	ゔぁ: "v a",
	ゔぃ: "v i",
	ゔぇ: "v e",
	ゔぉ: "v o",
	ゔゅ: "v u",
	くぁ: "k a",
	くぃ: "k i",
	くぇ: "k e",
	くぉ: "k o",
	ぐぁ: "g a",
	ぐぃ: "g i",
	ぐぇ: "g e",
	ぐぉ: "g o",
	すぃ: "s i",
	ずぃ: "z i",
};

/**
 * Katakana → hiragana, so ヴァ and ゔぁ resolve identically. Only the kana
 * block is folded; ー and everything else is left alone for the caller to
 * reject.
 */
export function toHiragana(s: string): string {
	let out = "";
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		// Katakana ァ(30A1)–ヶ(30F6) map onto hiragana ぁ(3041)–ゖ(3096).
		out += c >= 0x30a1 && c <= 0x30f6 ? String.fromCodePoint(c - 0x60) : ch;
	}
	return out;
}

function make(kana: string, pair: string): Syllable {
	const sp = pair.indexOf(" ");
	const consonant = pair.slice(0, sp);
	const vowel = pair.slice(sp + 1);
	return { kana, consonant, vowel, cls: CLASS_OF[consonant] ?? "vowel" };
}

/**
 * Resolve one kana or digraph starting at `i`, returning the syllable and how
 * many characters it consumed — or null if the text is not kana we know.
 */
function readSyllable(
	src: string,
	hira: string,
	i: number,
): { syl: Syllable; len: number } | null {
	const two = hira.slice(i, i + 2);
	if (two.length === 2) {
		const explicit = DIGRAPH[two];
		if (explicit) return { syl: make(src.slice(i, i + 2), explicit), len: 2 };

		const small = SMALL[two[1]];
		const base = KANA[two[0]];
		if (small && base) {
			const sp = base.indexOf(" ");
			const baseConsonant = base.slice(0, sp);
			const baseVowel = base.slice(sp + 1);
			// きゃ = k + i + a → a palatalised "ky" onset.
			if (baseVowel === "i" && CLASS_OF[`${baseConsonant}y`]) {
				const pair = `${baseConsonant}y ${small}`;
				return { syl: make(src.slice(i, i + 2), pair), len: 2 };
			}
			// いぇ / うぉ — a bare vowel gliding into another is a semivowel.
			if (!baseConsonant) {
				const glide = baseVowel === "i" ? "y" : baseVowel === "u" ? "w" : "";
				const syl = make(src.slice(i, i + 2), `${glide} ${small}`);
				// おぁ has no romanisable onset, but it still articulates like one.
				return { syl: { ...syl, cls: "semivowel" }, len: 2 };
			}
			// Anything else keeps the base consonant and takes the small kana as
			// its vowel: ぢぇ is /je/, くゎ is a labialised /ka/, づぉ is /zo/. The
			// nucleus is what the estimator needs, and this gets it right for every
			// combination a recording list can invent.
			return {
				syl: make(src.slice(i, i + 2), `${baseConsonant} ${small}`),
				len: 2,
			};
		}
	}

	const one = KANA[hira[i]];
	if (one) return { syl: make(src.slice(i, i + 1), one), len: 1 };
	return null;
}

/**
 * Split a kana string into moras.
 *
 * Returns null if any character is not kana we can resolve — that is the
 * signal to skip the file entirely, which is what keeps a bank's karaoke
 * tracks and readme audio out of the generated oto.ini.
 */
export function splitKana(text: string): Syllable[] | null {
	const src = text.normalize("NFC");
	const hira = toHiragana(src);
	const out: Syllable[] = [];

	for (let i = 0; i < hira.length; ) {
		const ch = hira[i];
		// っ marks a geminate: the closure belongs to the following mora, and
		// there is nothing to voice on its own.
		if (ch === "っ" || ch === "ー") {
			i++;
			continue;
		}
		const read = readSyllable(src, hira, i);
		if (!read) return null;
		out.push(read.syl);
		i += read.len;
	}

	return out.length > 0 ? out : null;
}

/**
 * Vowel a following mora connects to, as written in a 連続音 alias
 * (`a か`). ん connects as "n".
 */
export function connectingVowel(syl: Syllable): string {
	return syl.vowel;
}
