import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LibraryManager, resolveRadioToolPath } from './library.js';

const args = process.argv.slice(2);
const directory = args.find((arg) => !arg.startsWith('--'));
const strict = args.includes('--strict');
const recursive = args.includes('--recursive');

if (!directory) {
	console.error('Usage: bun run prepare:radio -- "C:\\path\\to\\music" [--strict] [--recursive]');
	process.exit(2);
}

const radioToolPath = await resolveExistingPath(resolveRadioToolPath());
if (!radioToolPath) {
	console.error('make-radio-sound.exe was not found. Run `bun run setup:radio-sound` or set RADIO_SOUND_EXE.');
	process.exit(2);
}

const manager = new LibraryManager(radioToolPath);
const scanned = await manager.scan(path.resolve(directory), { recursive });
console.log(`[scan] ${scanned.tracks.length} supported audio files (${recursive ? 'recursive' : 'root only'})`);
console.log(`[tool] ${radioToolPath}`);

const prepared = await manager.prepare(undefined, {
	continueOnError: !strict,
	onProgress: ({ type, track, index, total, message }) => {
		if (type === 'start') {
			console.log(`[${index}/${total}] prepare ${track.fileName}`);
			return;
		}

		if (type === 'skip') {
			console.log(`[${index}/${total}] skip    ${track.fileName}`);
			return;
		}

		if (type === 'success') {
			console.log(`[${index}/${total}] ready   ${track.fileName}`);
			return;
		}

		console.log(`[${index}/${total}] failed  ${track.fileName}: ${message}`);
	}
});

const ready = prepared.tracks.filter((track) => track.cacheReady);
const failed = prepared.tracks.filter((track) => track.error);
console.log(`[done] ${ready.length} ready, ${failed.length} failed`);
console.log(`[cache] ${path.join(prepared.directory, '.saru2radio-cache', 'tracks')}`);

if (failed.length > 0) {
	console.log('[failed]');
	for (const track of failed.slice(0, 20)) {
		console.log(`- ${track.fileName}: ${track.error}`);
	}
	if (failed.length > 20) {
		console.log(`- ...and ${failed.length - 20} more`);
	}
	if (strict) {
		process.exitCode = 1;
	}
}

async function resolveExistingPath(filePath: string | null): Promise<string | null> {
	if (!filePath) {
		return null;
	}

	try {
		await fs.access(filePath);
		return filePath;
	} catch {
		return null;
	}
}
