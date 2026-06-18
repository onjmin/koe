#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { parseOto } from './parse-oto.js';
import { normalizePcm } from './wav.js';
import { pack, type PackInput } from './pack.js';
import { parseFrqAverageF0, frqFileName } from './frq.js';
import { pitchFromAliasSuffix } from './pitch.js';
import { packKoe } from '../koe.js';

const [voiceDir, outDir = 'dist'] = process.argv.slice(2);

if (!voiceDir) {
  process.stderr.write('Usage: koe-convert <voice-dir> [output-dir]\n');
  process.exit(1);
}

async function findOtoFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === 'oto.ini') {
      found.push(join(e.parentPath ?? dirname(join(dir, e.name)), e.name));
    }
  }
  return found;
}

async function main() {
  const otoFiles = await findOtoFiles(voiceDir);
  if (otoFiles.length === 0) {
    process.stderr.write(`No oto.ini found under "${voiceDir}"\n`);
    process.exit(1);
  }

  const inputs: PackInput[] = [];
  let skipped = 0;

  for (const otoPath of otoFiles) {
    const otoDir = dirname(otoPath);
    const rawBytes = await readFile(otoPath);
    const content = new TextDecoder('shift_jis').decode(rawBytes);
    const entries = parseOto(content);

    for (const oto of entries) {
      const wavPath = join(otoDir, oto.wav);
      try {
        const wavBytes = await readFile(wavPath);
        const pcm = normalizePcm(wavBytes.buffer as ArrayBuffer);

        // Recorded pitch: prefer the .frq average, then the alias suffix.
        let recordedPitch = pitchFromAliasSuffix(oto.alias) ?? 0;
        try {
          const frqBytes = await readFile(join(otoDir, frqFileName(oto.wav)));
          const avg = parseFrqAverageF0(frqBytes.buffer as ArrayBuffer);
          if (avg) recordedPitch = avg;
        } catch { /* no frq file — fall back to suffix / autocorrelation */ }

        inputs.push({ oto, pcm, recordedPitch });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[skip] ${oto.alias} (${basename(wavPath)}): ${msg}\n`);
        skipped++;
      }
    }
  }

  if (inputs.length === 0) {
    process.stderr.write('No phonemes could be converted.\n');
    process.exit(1);
  }

  const { manifest, bin } = pack(inputs);

  // Single-file .koe archive, named after the source directory.
  const koeName = basename(resolve(voiceDir)) + '.koe';
  const koe = packKoe(manifest, [bin]);
  const koeBytes = Buffer.from(await koe.arrayBuffer());

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, koeName), koeBytes);

  const kb = (koeBytes.byteLength / 1024).toFixed(1);
  process.stdout.write(
    `Converted ${inputs.length} phonemes (${skipped} skipped) → ${join(outDir, koeName)}  [${kb} KB]\n`,
  );
}

main().catch(err => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
