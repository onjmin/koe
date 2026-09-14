#!/usr/bin/env node
/**
 * `koe-oto <dir>` — walk a voice bank and write an oto.ini next to every folder
 * of WAVs it finds, estimating all five parameters from the audio.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
	generateOto,
	suffixFromFolderName,
	type WavInput,
} from "./generate.js";
import { encodeOto } from "./write.js";

interface Args {
	root: string;
	force: boolean;
	dryRun: boolean;
	suffix?: string;
	quiet: boolean;
}

function parseArgs(argv: string[]): Args | null {
	let root = "";
	let force = false;
	let dryRun = false;
	let quiet = false;
	let suffix: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--force" || a === "-f") force = true;
		else if (a === "--dry-run" || a === "-n") dryRun = true;
		else if (a === "--quiet" || a === "-q") quiet = true;
		else if (a === "--suffix") suffix = argv[++i] ?? "";
		else if (a.startsWith("--suffix=")) suffix = a.slice(9);
		else if (a.startsWith("-")) return null;
		else if (!root) root = a;
		else return null;
	}

	return root ? { root, force, dryRun, suffix, quiet } : null;
}

const USAGE = `Usage: koe-oto <voice-bank-dir> [options]

Estimates UTAU oto.ini parameters from the recordings themselves and writes one
oto.ini into every folder that holds WAV files.

Options:
  -f, --force        overwrite an existing oto.ini (a .bak copy is kept)
  -n, --dry-run      report what would be written, write nothing
      --suffix <s>   append <s> to every alias (default: the folder's note name)
  -q, --quiet        only print the summary
`;

/** Every directory under `root` that directly contains at least one WAV. */
async function findWavFolders(root: string): Promise<Map<string, string[]>> {
	const folders = new Map<string, string[]>();
	const walk = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true });
		const wavs = entries
			.filter((e) => e.isFile() && /\.wav$/i.test(e.name))
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b, "ja"));
		if (wavs.length > 0) folders.set(dir, wavs);
		for (const e of entries) {
			if (e.isDirectory()) await walk(join(dir, e.name));
		}
	};
	await walk(root);
	return folders;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
	return buf.buffer.slice(
		buf.byteOffset,
		buf.byteOffset + buf.byteLength,
	) as ArrayBuffer;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (!args) {
		process.stderr.write(USAGE);
		process.exit(1);
	}

	const root = resolve(args.root);
	const folders = await findWavFolders(root);
	if (folders.size === 0) {
		process.stderr.write(`No WAV files found under "${root}"\n`);
		process.exit(1);
	}

	const log = (s: string) => {
		if (!args.quiet) process.stdout.write(s);
	};

	let totalEntries = 0;
	let totalSkipped = 0;
	let written = 0;
	let blocked = 0;

	for (const [dir, names] of folders) {
		const label = relative(root, dir) || basename(root);
		const files: WavInput[] = [];
		for (const name of names) {
			files.push({
				name,
				data: toArrayBuffer(await readFile(join(dir, name))),
			});
		}

		const suffix = args.suffix ?? suffixFromFolderName(basename(dir));
		const result = generateOto(files, { suffix });
		totalEntries += result.entries.length;
		totalSkipped += result.skipped.length;

		if (result.entries.length === 0) {
			log(`  --  ${label}: no usable recordings (${names.length} wav)\n`);
			continue;
		}

		const otoPath = join(dir, "oto.ini");
		const already = await exists(otoPath);
		const detail = `${result.entries.length} entries from ${names.length} wav [${result.style}]${
			result.skipped.length ? `, ${result.skipped.length} skipped` : ""
		}`;

		if (args.dryRun) {
			log(`  ..  ${label}: ${detail}${already ? " (would overwrite)" : ""}\n`);
			continue;
		}
		if (already && !args.force) {
			log(
				`  !!  ${label}: oto.ini exists — rerun with --force to replace it\n`,
			);
			blocked++;
			continue;
		}
		if (already) {
			// Keep the human-made settings recoverable; they are usually worth more
			// than anything estimated from the waveform alone.
			await writeFile(`${otoPath}.bak`, await readFile(otoPath));
		}

		await writeFile(otoPath, encodeOto(result.entries));
		written++;
		log(`  ok  ${label}: ${detail}\n`);
	}

	process.stdout.write(
		`${args.dryRun ? "Would write" : "Wrote"} ${args.dryRun ? folders.size : written} oto.ini — ` +
			`${totalEntries} entries, ${totalSkipped} files skipped\n`,
	);
	if (blocked > 0) {
		process.stdout.write(
			`${blocked} folder(s) already had an oto.ini; rerun with --force to replace them.\n`,
		);
	}
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
	process.exit(1);
});
