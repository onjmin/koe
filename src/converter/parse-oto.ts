export interface OtoEntry {
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
 *
 * Aliases and filenames are normalised to NFC, so `が` written as `か` + U+3099
 * is the same alias the synthesiser looks up. Match the WAV with
 * {@link fileKey} on the file side too: banks unpacked from a macOS zip keep
 * NFD names on disk while oto.ini spells them in NFC.
 */
export function parseOto(content: string): OtoEntry[] {
	const entries: OtoEntry[] = [];

	for (const raw of content.normalize("NFC").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;

		const eq = line.indexOf("=");
		if (eq === -1) continue;

		const wav = line.slice(0, eq).trim();
		const parts = line.slice(eq + 1).split(",");
		if (parts.length < 6) continue;

		const [alias, offsetStr, consonantStr, cutoffStr, preStr, overlapStr] =
			parts;
		// Empty alias → use filename without extension (UTAU spec default)
		const aliasStr = alias.trim() || wav.replace(/\.[^.]+$/, "");
		const entry: OtoEntry = {
			wav,
			alias: aliasStr,
			offset: parseFloat(offsetStr) || 0,
			consonant: parseFloat(consonantStr) || 0,
			cutoff: parseFloat(cutoffStr) || 0,
			pre: parseFloat(preStr) || 0,
			overlap: parseFloat(overlapStr) || 0,
		};

		if (!entry.alias) continue;
		entries.push(entry);
	}

	return entries;
}

/**
 * Key for matching an oto.ini filename against files on disk or in a zip:
 * NFC with forward slashes. Normalise both sides with this.
 */
export function fileKey(path: string): string {
	return path.normalize("NFC").replace(/\\/g, "/");
}
