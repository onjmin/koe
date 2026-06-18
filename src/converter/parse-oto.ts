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
 */
export function parseOto(content: string): OtoEntry[] {
  const entries: OtoEntry[] = [];

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const wav = line.slice(0, eq).trim();
    const parts = line.slice(eq + 1).split(',');
    if (parts.length < 6) continue;

    const [alias, offsetStr, consonantStr, cutoffStr, preStr, overlapStr] = parts;
    const entry: OtoEntry = {
      wav,
      alias: alias.trim(),
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
