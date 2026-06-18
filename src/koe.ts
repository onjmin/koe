import type { Manifest } from './types.js';

/** Magic number 'KOE\0' (stored big-endian as 0x4B 0x4F 0x45 0x00). */
const MAGIC = 0x4b4f4500;

/**
 * Koe Archive Format (.koe)
 *   [4B] magic 'KOE\0' (big-endian)
 *   [4B] JSON length (little-endian)
 *   [N ] manifest JSON (UTF-8)
 *   [M ] raw PCM (Int16 / 48kHz / mono); phoneme offsets are relative to here
 */
export function packKoe(manifest: Manifest, pcmParts: BlobPart[]): Blob {
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new ArrayBuffer(8);
  const view = new DataView(header);
  view.setUint32(0, MAGIC, false); // magic, big-endian
  view.setUint32(4, json.byteLength, true); // json length, little-endian
  return new Blob([header, json, ...pcmParts]);
}

/** Read the 8-byte header → JSON length. Throws on bad magic. */
export function parseKoeHeader(headerBytes: ArrayBuffer): { jsonLength: number } {
  const view = new DataView(headerBytes);
  if (view.byteLength < 8 || view.getUint32(0, false) !== MAGIC) {
    throw new Error('Not a .koe file (bad magic)');
  }
  return { jsonLength: view.getUint32(4, true) };
}

/** Byte offset where PCM data begins, given the JSON length. */
export const pcmBase = (jsonLength: number): number => 8 + jsonLength;
