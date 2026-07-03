import { unzipSync } from "fflate";

/** Minimal file-like handle so zip entries can stand in for `File` objects. */
export interface ZipFile {
	arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Extracts a zip archive into a flat path → file map, mirroring the shape of
 * `webkitdirectory` file lists so the converter can treat both sources the same.
 *
 * Many UTAU voicebank zips are packed on Windows without the UTF-8 flag, so
 * entry names are Shift_JIS bytes. fflate decodes those as latin1 (1 byte =
 * 1 code point) rather than mangling them, so we can losslessly recover the
 * original bytes and re-decode with the right encoding per entry.
 */
export function unzipToFileMap(
	data: ArrayBuffer,
): Promise<Record<string, ZipFile>> {
	const bytes = new Uint8Array(data);
	const unzipped = unzipSync(bytes);
	const isUtf8ByIndex = readUtf8Flags(bytes);
	const sjisDecoder = new TextDecoder("shift_jis");

	const fileMap: Record<string, ZipFile> = {};
	Object.keys(unzipped).forEach((rawName, i) => {
		const fileBytes = unzipped[rawName];
		const name = isUtf8ByIndex[i]
			? rawName
			: sjisDecoder.decode(Uint8Array.from(rawName, (c) => c.charCodeAt(0)));
		const path = name.replace(/\\/g, "/");
		if (path.endsWith("/")) return; // directory entry
		fileMap[path] = {
			arrayBuffer: () =>
				Promise.resolve(
					fileBytes.buffer.slice(
						fileBytes.byteOffset,
						fileBytes.byteOffset + fileBytes.byteLength,
					),
				),
		};
	});
	return Promise.resolve(fileMap);
}

/** Walks the central directory to read the UTF-8 language flag (bit 11) of each entry, in order. */
function readUtf8Flags(buf: Uint8Array): boolean[] {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

	let eocd = -1;
	const maxBack = Math.min(buf.length, 65557); // 22 + max comment length
	for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return [];

	const entryCount = view.getUint16(eocd + 10, true);
	let cdOffset = view.getUint32(eocd + 16, true);

	const flags: boolean[] = [];
	for (let i = 0; i < entryCount; i++) {
		if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
		const flag = view.getUint16(cdOffset + 8, true);
		const nameLen = view.getUint16(cdOffset + 28, true);
		const extraLen = view.getUint16(cdOffset + 30, true);
		const commentLen = view.getUint16(cdOffset + 32, true);
		flags.push((flag & 0x800) !== 0);
		cdOffset += 46 + nameLen + extraLen + commentLen;
	}
	return flags;
}
