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
export function parseFrqAverageF0(buffer: ArrayBuffer): number | null {
  if (buffer.byteLength < 20) return null;
  const view = new DataView(buffer);

  let header = '';
  for (let i = 0; i < 8; i++) header += String.fromCharCode(view.getUint8(i));
  if (header !== 'FREQ0003') return null;

  const avg = view.getFloat64(12, true); // little-endian
  return Number.isFinite(avg) && avg > 0 ? avg : null;
}

/** Map a WAV filename to its sibling frq filename: "あ.wav" → "あ_wav.frq". */
export function frqFileName(wavName: string): string {
  const dot = wavName.lastIndexOf('.');
  const base = dot >= 0 ? wavName.slice(0, dot) : wavName;
  const ext = dot >= 0 ? wavName.slice(dot + 1) : 'wav';
  return `${base}_${ext}.frq`;
}
