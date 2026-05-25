import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';
import type { LibraryState, Track } from '../src/lib/types.js';
import {
	cacheFileName,
	createTrackId,
	isCacheFresh,
	isSupportedAudio,
	radioPresetKey,
	RADIO_PRESET,
	stableTrackSeed,
	type CacheFingerprint
} from './library-core.js';
import { RADIO_SOUND_EXE } from './paths.js';

const execFileAsync = promisify(execFile);
const CACHE_DIR_NAME = '.saru2radio-cache';
const CACHE_TRACKS_DIR_NAME = 'tracks';
const BROADCAST_AUDIO_EXTENSIONS = new Set(['.mp3']);

type ManifestTrack = CacheFingerprint & {
	cachePath: string;
	title: string;
	artist: string;
	duration: number | null;
};

type CacheManifest = {
	version: 1;
	preset: string;
	tracks: Record<string, ManifestTrack>;
};

type PrepareProgress = {
	type: 'skip' | 'start' | 'success' | 'error';
	track: Track;
	index: number;
	total: number;
	message?: string;
};

type PrepareOptions = {
	continueOnError?: boolean;
	onProgress?: (progress: PrepareProgress) => void;
};

type ScanOptions = {
	recursive?: boolean;
};

export class LibraryManager {
	private state: LibraryState = {
		directory: '',
		tracks: [],
		preparing: false,
		lastScanAt: null,
		recursive: false,
		sourceKind: 'empty'
	};

	constructor(private readonly radioToolPath: string | null) {}

	getState(): LibraryState {
		return structuredClone(this.state);
	}

	async scan(directory: string, options: ScanOptions = {}): Promise<LibraryState> {
		const normalized = path.resolve(directory);
		const stat = await fs.stat(normalized);
		if (!stat.isDirectory()) {
			throw new Error('Music path is not a directory.');
		}

		const manifest = await readManifest(normalized);
		const files = await findAudioFiles(normalized, { recursive: options.recursive ?? true });
		const tracks: Track[] = [];

		for (const file of files) {
			const fileStat = await fs.stat(file);
			const id = createTrackId(file);
			const metadata = await readTrackMetadata(file);
			const cachePath = path.join(normalized, CACHE_DIR_NAME, 'tracks', cacheFileName(file));
			const manifestEntry = manifest.tracks[id];
			const cacheExists = await fileExists(cachePath);
			const fresh = cacheExists
				? isCacheFresh(manifestEntry, {
						sourcePath: file,
						size: fileStat.size,
						mtimeMs: fileStat.mtimeMs
					})
				: false;

			tracks.push({
				id,
				sourcePath: file,
				playPath: cachePath,
				fileName: path.basename(file),
				title: metadata.title,
				artist: metadata.artist,
				duration: metadata.duration,
				size: fileStat.size,
				mtimeMs: fileStat.mtimeMs,
				cachePath,
				cacheReady: fresh,
				cacheStale: cacheExists && !fresh
			});
		}

		this.state = {
			directory: normalized,
			tracks: tracks.sort((left, right) => left.fileName.localeCompare(right.fileName)),
			preparing: false,
			lastScanAt: new Date().toISOString(),
			recursive: options.recursive ?? true,
			sourceKind: 'prepare-source'
		};
		return this.getState();
	}

	async scanBroadcast(directory: string, options: ScanOptions = {}): Promise<LibraryState> {
		const normalized = path.resolve(directory);
		const stat = await fs.stat(normalized);
		if (!stat.isDirectory()) {
			throw new Error('Broadcast path is not a directory.');
		}

		const source = await resolveBroadcastSource(normalized);
		const tracks = source.manifest
			? await tracksFromManifest(source)
			: await tracksFromReadyFolder(source.tracksDirectory, { recursive: options.recursive ?? false });

		this.state = {
			directory: normalized,
			tracks: tracks.sort((left, right) => left.fileName.localeCompare(right.fileName)),
			preparing: false,
			lastScanAt: new Date().toISOString(),
			recursive: options.recursive ?? false,
			sourceKind: source.kind
		};
		return this.getState();
	}

	async prepare(trackIds?: string[], options: PrepareOptions = {}): Promise<LibraryState> {
		if (!this.state.directory) {
			throw new Error('Scan a music directory first.');
		}

		if (!this.radioToolPath) {
			throw new Error('make-radio-sound.exe was not found. Run `npm run setup:radio-sound` or set RADIO_SOUND_EXE.');
		}

		this.state.preparing = true;
		const selected = new Set(trackIds?.length ? trackIds : this.state.tracks.map((track) => track.id));
		const selectedTracks = this.state.tracks.filter((track) => selected.has(track.id));
		const manifest = await readManifest(this.state.directory);
		const tracksDir = path.join(this.state.directory, CACHE_DIR_NAME, 'tracks');
		await fs.mkdir(tracksDir, { recursive: true });

		try {
			for (let index = 0; index < selectedTracks.length; index += 1) {
				const track = selectedTracks[index];
				const entry = manifest.tracks[track.id];
				if (track.cacheReady && isCacheFresh(entry, track)) {
					options.onProgress?.({ type: 'skip', track, index: index + 1, total: selectedTracks.length });
					continue;
				}

				if (track.size === 0) {
					const message = 'Empty audio file.';
					track.cacheReady = false;
					track.cacheStale = false;
					track.error = message;
					delete manifest.tracks[track.id];
					options.onProgress?.({
						type: 'error',
						track,
						index: index + 1,
						total: selectedTracks.length,
						message
					});

					if (!options.continueOnError) {
						throw new Error(`${track.fileName}: ${message}`);
					}
					continue;
				}

				options.onProgress?.({ type: 'start', track, index: index + 1, total: selectedTracks.length });
				try {
					await runRadioTool(this.radioToolPath, track.sourcePath, track.cachePath, stableTrackSeed(track.sourcePath));
					track.cacheReady = true;
					track.cacheStale = false;
					track.playPath = track.cachePath;
					track.error = undefined;
					manifest.tracks[track.id] = {
						sourcePath: track.sourcePath,
						size: track.size,
						mtimeMs: track.mtimeMs,
						preset: radioPresetKey(),
						cachePath: track.cachePath,
						title: track.title,
						artist: track.artist,
						duration: track.duration
					};
					options.onProgress?.({ type: 'success', track, index: index + 1, total: selectedTracks.length });
					await writeManifest(this.state.directory, manifest);
				} catch (error) {
					const message = formatPrepareError(error);
					track.cacheReady = false;
					track.cacheStale = false;
					track.error = message;
					delete manifest.tracks[track.id];
					options.onProgress?.({
						type: 'error',
						track,
						index: index + 1,
						total: selectedTracks.length,
						message
					});

					if (!options.continueOnError) {
						throw new Error(`${track.fileName}: ${message}`);
					}
				}
			}
		} finally {
			this.state.preparing = false;
		}

		await writeManifest(this.state.directory, manifest);
		return this.getState();
	}

	getTrack(trackId: string): Track | undefined {
		return this.state.tracks.find((track) => track.id === trackId);
	}
}

export function resolveRadioToolPath(): string | null {
	const configured = process.env.RADIO_SOUND_EXE;
	if (configured) {
		return path.resolve(configured);
	}

	return RADIO_SOUND_EXE;
}

async function findAudioFiles(directory: string, options: Required<ScanOptions>): Promise<string[]> {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!options.recursive || entry.name === CACHE_DIR_NAME || entry.name === 'node_modules') {
				continue;
			}
			files.push(...(await findAudioFiles(fullPath, options)));
		} else if (entry.isFile() && isSupportedAudio(fullPath)) {
			files.push(fullPath);
		}
	}

	return files;
}

type BroadcastSource = {
	kind: LibraryState['sourceKind'];
	directory: string;
	tracksDirectory: string;
	manifest: CacheManifest | null;
};

async function resolveBroadcastSource(directory: string): Promise<BroadcastSource> {
	const name = path.basename(directory).toLowerCase();
	const parentName = path.basename(path.dirname(directory)).toLowerCase();

	if (name === CACHE_TRACKS_DIR_NAME && parentName === CACHE_DIR_NAME) {
		const cacheDirectory = path.dirname(directory);
		return {
			kind: 'cache-tracks',
			directory,
			tracksDirectory: directory,
			manifest: await readManifestIfExists(cacheDirectory)
		};
	}

	if (name === CACHE_DIR_NAME) {
		return {
			kind: 'cache-manifest',
			directory,
			tracksDirectory: path.join(directory, CACHE_TRACKS_DIR_NAME),
			manifest: await readManifestIfExists(directory)
		};
	}

	const cacheDirectory = path.join(directory, CACHE_DIR_NAME);
	const manifest = await readManifestIfExists(cacheDirectory);
	if (manifest) {
		return {
			kind: 'cache-manifest',
			directory,
			tracksDirectory: path.join(cacheDirectory, CACHE_TRACKS_DIR_NAME),
			manifest
		};
	}

	return {
		kind: 'ready-folder',
		directory,
		tracksDirectory: directory,
		manifest: null
	};
}

async function tracksFromManifest(source: BroadcastSource): Promise<Track[]> {
	if (!source.manifest) {
		return [];
	}

	const tracks: Track[] = [];
	for (const [id, entry] of Object.entries(source.manifest.tracks)) {
		const playPath = await resolveManifestPlayPath(entry, source.tracksDirectory);
		if (!playPath) {
			continue;
		}

		const fileStat = await fs.stat(playPath);
		const sourcePath = entry.sourcePath || playPath;
		tracks.push({
			id,
			sourcePath,
			playPath,
			fileName: path.basename(sourcePath),
			title: entry.title || path.parse(sourcePath).name,
			artist: entry.artist || 'Unknown artist',
			duration: entry.duration ?? null,
			size: fileStat.size,
			mtimeMs: fileStat.mtimeMs,
			cachePath: playPath,
			cacheReady: true,
			cacheStale: false
		});
	}
	return tracks;
}

async function tracksFromReadyFolder(directory: string, options: Required<ScanOptions>): Promise<Track[]> {
	const files = await findBroadcastAudioFiles(directory, options);
	const tracks: Track[] = [];

	for (const file of files) {
		const fileStat = await fs.stat(file);
		const metadata = await readTrackMetadata(file);
		tracks.push({
			id: createTrackId(file),
			sourcePath: file,
			playPath: file,
			fileName: path.basename(file),
			title: metadata.title,
			artist: metadata.artist,
			duration: metadata.duration,
			size: fileStat.size,
			mtimeMs: fileStat.mtimeMs,
			cachePath: file,
			cacheReady: true,
			cacheStale: false
		});
	}
	return tracks;
}

async function findBroadcastAudioFiles(directory: string, options: Required<ScanOptions>): Promise<string[]> {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!options.recursive || entry.name === CACHE_DIR_NAME || entry.name === 'node_modules') {
				continue;
			}
			files.push(...(await findBroadcastAudioFiles(fullPath, options)));
		} else if (entry.isFile() && BROADCAST_AUDIO_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) {
			files.push(fullPath);
		}
	}

	return files;
}

async function resolveManifestPlayPath(entry: ManifestTrack, tracksDirectory: string): Promise<string | null> {
	const candidates = [entry.cachePath, path.join(tracksDirectory, path.basename(entry.cachePath))].filter(Boolean);
	for (const candidate of candidates) {
		if (await fileExists(candidate)) {
			return candidate;
		}
	}
	return null;
}

async function readTrackMetadata(filePath: string): Promise<{ title: string; artist: string; duration: number | null }> {
	try {
		const metadata = await parseFile(filePath, { duration: true });
		return {
			title: metadata.common.title?.trim() || path.parse(filePath).name,
			artist: metadata.common.artist?.trim() || 'Unknown artist',
			duration: metadata.format.duration ?? null
		};
	} catch {
		return {
			title: path.parse(filePath).name,
			artist: 'Unknown artist',
			duration: null
		};
	}
}

async function runRadioTool(exePath: string, input: string, output: string, seed: number): Promise<void> {
	await fs.mkdir(path.dirname(output), { recursive: true });
	await execFileAsync(exePath, [
		input,
		'-o',
		output,
		'--mode',
		RADIO_PRESET.mode,
		'--intensity',
		String(RADIO_PRESET.intensity),
		'--seed',
		String(seed),
		'--format',
		RADIO_PRESET.format
	]);
}

function formatPrepareError(error: unknown): string {
	const execError = error as { stderr?: unknown; stdout?: unknown } | null;
	const stderr = typeof execError?.stderr === 'string' ? execError.stderr : '';
	const stdout = typeof execError?.stdout === 'string' ? execError.stdout : '';
	const message = error instanceof Error ? error.message : String(error);
	const combined = [stderr, stdout, message].filter(Boolean).join('\n');
	const ffmpegLine = combined
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.includes('Invalid data found') || line.includes('Failed to find') || line.startsWith('ffmpeg failed:'));

	return ffmpegLine ?? combined.split(/\r?\n/).find(Boolean) ?? 'Could not convert track.';
}

async function readManifest(directory: string): Promise<CacheManifest> {
	const manifestPath = path.join(directory, CACHE_DIR_NAME, 'manifest.json');
	try {
		return JSON.parse(await fs.readFile(manifestPath, 'utf8')) as CacheManifest;
	} catch {
		return {
			version: 1,
			preset: radioPresetKey(),
			tracks: {}
		};
	}
}

async function readManifestIfExists(cacheDirectory: string): Promise<CacheManifest | null> {
	try {
		return JSON.parse(await fs.readFile(path.join(cacheDirectory, 'manifest.json'), 'utf8')) as CacheManifest;
	} catch {
		return null;
	}
}

async function writeManifest(directory: string, manifest: CacheManifest): Promise<void> {
	const manifestPath = path.join(directory, CACHE_DIR_NAME, 'manifest.json');
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
