/**
 * oto.ini serialisation.
 *
 * UTAU reads oto.ini as Shift-JIS, and OpenUtau follows a bank's declared
 * encoding, so writing UTF-8 would leave every kana alias mojibake in the
 * original editor. There is no Shift-JIS *encoder* in the platform — only a
 * decoder — so the table is built by decoding every legal byte pair once and
 * inverting the result.
 */

import type { OtoEntry } from "../converter/parse-oto.js";

let reverseTable: Map<string, number> | null = null;

function shiftJisTable(): Map<string, number> {
	if (reverseTable) return reverseTable;
	const table = new Map<string, number>();
	const decoder = new TextDecoder("shift_jis", { fatal: false });

	// ASCII, plus the yen/overline substitutions Shift-JIS makes at 0x5C/0x7E.
	for (let b = 0; b < 0x80; b++) {
		table.set(decoder.decode(new Uint8Array([b])), b);
	}
	// Half-width katakana.
	for (let b = 0xa1; b <= 0xdf; b++) {
		table.set(decoder.decode(new Uint8Array([b])), b);
	}
	// Two-byte planes.
	const pair = new Uint8Array(2);
	for (let lead = 0x81; lead <= 0xfc; lead++) {
		if (lead > 0x9f && lead < 0xe0) continue;
		pair[0] = lead;
		for (let trail = 0x40; trail <= 0xfc; trail++) {
			if (trail === 0x7f) continue;
			pair[1] = trail;
			const ch = decoder.decode(pair);
			// A byte pair the decoder rejects comes back as U+FFFD, and a few map
			// to two characters; neither is usable as a round-trip entry.
			if (ch.length !== 1 || ch === "�") continue;
			if (!table.has(ch)) table.set(ch, (lead << 8) | trail);
		}
	}

	reverseTable = table;
	return table;
}

/**
 * Encode text as Shift-JIS. Characters with no Shift-JIS form become `?`,
 * matching what UTAU's own tools do rather than corrupting the line.
 */
export function encodeShiftJis(text: string): Uint8Array {
	const table = shiftJisTable();
	const out: number[] = [];
	for (const ch of text) {
		const code = table.get(ch);
		if (code === undefined) out.push(0x3f);
		else if (code > 0xff) out.push(code >> 8, code & 0xff);
		else out.push(code);
	}
	return new Uint8Array(out);
}

/** Trim trailing zeros so `120.000` prints as `120`. */
function num(v: number): string {
	const s = v.toFixed(3);
	return s.replace(/\.?0+$/, "") || "0";
}

/** Render entries as oto.ini text (CRLF, as UTAU writes it). */
export function formatOto(entries: readonly OtoEntry[]): string {
	return entries
		.map(
			(e) =>
				`${e.wav}=${e.alias},${num(e.offset)},${num(e.consonant)},${num(e.cutoff)},${num(e.pre)},${num(e.overlap)}`,
		)
		.join("\r\n")
		.concat("\r\n");
}

/** Render entries as Shift-JIS oto.ini bytes, ready to write to disk. */
export function encodeOto(entries: readonly OtoEntry[]): Uint8Array {
	return encodeShiftJis(formatOto(entries));
}
