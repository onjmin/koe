#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { packKoe } from "../koe.js";
import { convertVoicebank, type VoiceFile } from "./convert.js";

const [voiceDir, outDir = "dist"] = process.argv.slice(2);

if (!voiceDir) {
	process.stderr.write("Usage: koe-convert <voice-dir> [output-dir]\n");
	process.exit(1);
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

/**
 * Every file under `dir`, keyed by its path relative to `dir` (read lazily).
 * Only files inside the directory are listed, so an oto.ini entry that points
 * outside the bank simply finds nothing.
 */
async function listFiles(dir: string): Promise<[string, VoiceFile][]> {
	const entries = await readdir(dir, { withFileTypes: true, recursive: true });
	return entries
		.filter((e) => e.isFile())
		.map((e) => {
			const path = join(e.parentPath ?? dir, e.name);
			return [
				relative(dir, path),
				{ arrayBuffer: async () => toArrayBuffer(await readFile(path)) },
			];
		});
}

async function main() {
	const files = await listFiles(voiceDir);
	const result = await convertVoicebank(files, {
		onSkip: (oto, reason) =>
			process.stderr.write(`[skip] ${oto.alias} (${oto.wav}): ${reason}\n`),
	});
	if (result.otoFiles === 0) {
		process.stderr.write(`No oto.ini found under "${voiceDir}"\n`);
		process.exit(1);
	}
	if (result.count === 0) {
		process.stderr.write("No phonemes could be converted.\n");
		process.exit(1);
	}

	// Single-file .koe archive, named after the source directory.
	const koeName = `${basename(resolve(voiceDir))}.koe`;
	const koe = packKoe(result.manifest, [result.bin]);
	const koeBytes = Buffer.from(await koe.arrayBuffer());

	await mkdir(outDir, { recursive: true });
	await writeFile(join(outDir, koeName), koeBytes);

	const kb = (koeBytes.byteLength / 1024).toFixed(1);
	process.stdout.write(
		`Converted ${result.count} phonemes (${result.skipped} skipped) → ${join(outDir, koeName)}  [${kb} KB]\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`${err}\n`);
	process.exit(1);
});
