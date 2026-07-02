#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { packKoe } from "../koe.js";
import { frqFileName, parseFrqAverageF0 } from "./frq.js";
import { type PackInput, pack } from "./pack.js";
import { parseOto } from "./parse-oto.js";
import { pitchFromAliasSuffix } from "./pitch.js";
import { normalizePcm } from "./wav.js";

const [voiceDir, outDir = "dist"] = process.argv.slice(2);

if (!voiceDir) {
	process.stderr.write("Usage: koe-convert <voice-dir> [output-dir]\n");
	process.exit(1);
}

/**
 * Resolve a filename taken from oto.ini, rejecting paths that escape the
 * directory — otherwise a malicious `wav=..\..\...` entry could pull arbitrary
 * files from outside the voice bank into the archive.
 */
function resolveInside(dir: string, name: string): string {
	const root = resolve(dir);
	const path = resolve(root, name);
	if (path !== root && !path.startsWith(root + sep)) {
		throw new Error(`path escapes voice bank directory: ${name}`);
	}
	return path;
}

/**
 * Copy a Buffer's exact byte range into a standalone ArrayBuffer. Buffers
 * under 4 KiB come from Node's shared allocation pool, so `.buffer` alone
 * would expose the whole pool at the wrong offset.
 */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
	return buf.buffer.slice(
		buf.byteOffset,
		buf.byteOffset + buf.byteLength,
	) as ArrayBuffer;
}

async function findOtoFiles(dir: string): Promise<string[]> {
	const found: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true, recursive: true });
	for (const e of entries) {
		if (e.isFile() && e.name.toLowerCase() === "oto.ini") {
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
		// UTAU oto.ini is traditionally Shift-JIS; honour a UTF-8 BOM when present.
		const isUtf8Bom =
			rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf;
		const content = new TextDecoder(isUtf8Bom ? "utf-8" : "shift_jis").decode(
			rawBytes,
		);
		const entries = parseOto(content);

		for (const oto of entries) {
			try {
				const wavPath = resolveInside(otoDir, oto.wav);
				const wavBytes = await readFile(wavPath);
				const pcm = normalizePcm(toArrayBuffer(wavBytes));

				// Recorded pitch: prefer the .frq average, then the alias suffix.
				let recordedPitch = pitchFromAliasSuffix(oto.alias) ?? 0;
				try {
					const frqBytes = await readFile(
						resolveInside(otoDir, frqFileName(oto.wav)),
					);
					const avg = parseFrqAverageF0(toArrayBuffer(frqBytes));
					if (avg) recordedPitch = avg;
				} catch {
					/* no frq file — fall back to suffix / autocorrelation */
				}

				inputs.push({ oto, pcm, recordedPitch });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(
					`[skip] ${oto.alias} (${basename(oto.wav)}): ${msg}\n`,
				);
				skipped++;
			}
		}
	}

	if (inputs.length === 0) {
		process.stderr.write("No phonemes could be converted.\n");
		process.exit(1);
	}

	const { manifest, bin } = pack(inputs);

	// Single-file .koe archive, named after the source directory.
	const koeName = `${basename(resolve(voiceDir))}.koe`;
	const koe = packKoe(manifest, [bin]);
	const koeBytes = Buffer.from(await koe.arrayBuffer());

	await mkdir(outDir, { recursive: true });
	await writeFile(join(outDir, koeName), koeBytes);

	const kb = (koeBytes.byteLength / 1024).toFixed(1);
	process.stdout.write(
		`Converted ${inputs.length} phonemes (${skipped} skipped) → ${join(outDir, koeName)}  [${kb} KB]\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`${err}\n`);
	process.exit(1);
});
