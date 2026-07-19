import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibraryManager, resolveRadioToolPath } from '../server/library.js';
import { RADIO_SOUND_EXE } from '../server/paths.js';
import { StudioStateStore } from '../server/studio-state.js';

describe('LibraryManager', () => {
	it('resolves the repo-local radio tool path unless RADIO_SOUND_EXE is set', () => {
		const original = process.env.RADIO_SOUND_EXE;

		try {
			delete process.env.RADIO_SOUND_EXE;
			expect(resolveRadioToolPath()).toBe(RADIO_SOUND_EXE);

			const customToolPath = path.join('C:', 'CustomTools', 'make-radio-sound.exe');
			process.env.RADIO_SOUND_EXE = customToolPath;
			expect(resolveRadioToolPath()).toBe(path.resolve(customToolPath));
		} finally {
			if (original === undefined) {
				delete process.env.RADIO_SOUND_EXE;
			} else {
				process.env.RADIO_SOUND_EXE = original;
			}
		}
	});

	it('points users at the setup script when preparation is requested without the tool', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-missing-tool-'));

		try {
			await fs.writeFile(path.join(directory, 'root.mp3'), 'not-real-audio');
			const manager = new LibraryManager(null);
			await manager.scan(directory);

			await expect(manager.prepare()).rejects.toThrow('bun run setup:radio-sound');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects preparation from broadcast-library state before an output can touch source audio', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-broadcast-guard-'));
		const sourcePath = path.join(directory, 'original.mp3');
		let runnerCalled = false;

		try {
			await fs.writeFile(sourcePath, 'original-audio');
			const manager = new LibraryManager('fake-tool', async () => {
				runnerCalled = true;
			});
			await manager.scanBroadcast(directory);

			await expect(manager.prepare()).rejects.toThrow('Preparation requires a source scan');
			expect(runnerCalled).toBe(false);
			expect(await fs.readFile(sourcePath, 'utf8')).toBe('original-audio');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('prepares source scans under the cache and preserves original audio', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-source-safety-'));
		const sourcePath = path.join(directory, 'original.mp3');

		try {
			await fs.writeFile(sourcePath, 'original-audio');
			const manager = new LibraryManager('fake-tool', async (_exePath, input, output) => {
				expect(input).toBe(sourcePath);
				expect(output).toContain(path.join('.saru2radio-cache', 'tracks'));
				expect(output).not.toBe(sourcePath);
				await fs.writeFile(output, 'prepared-audio');
			});
			await manager.scan(directory, { recursive: false });
			const prepared = await manager.prepare();

			expect(prepared.tracks[0].cacheReady).toBe(true);
			expect(await fs.readFile(sourcePath, 'utf8')).toBe('original-audio');
			expect(await fs.readFile(prepared.tracks[0].cachePath, 'utf8')).toBe('prepared-audio');

			const manifest = JSON.parse(
				await fs.readFile(path.join(directory, '.saru2radio-cache', 'manifest.json'), 'utf8')
			) as { tracks: Record<string, unknown> };
			expect(Object.keys(manifest.tracks)).toEqual([prepared.tracks[0].id]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('treats an empty track selection as no work', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-empty-selection-'));
		let runnerCalled = false;

		try {
			await fs.writeFile(path.join(directory, 'original.mp3'), 'original-audio');
			const manager = new LibraryManager('fake-tool', async () => {
				runnerCalled = true;
			});
			await manager.scan(directory, { recursive: false });
			const prepared = await manager.prepare([]);

			expect(runnerCalled).toBe(false);
			expect(prepared.tracks[0].cacheReady).toBe(false);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('can scan only the selected directory root for CLI preparation', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-library-'));

		try {
			await fs.writeFile(path.join(directory, 'root.mp3'), 'not-real-audio');
			await fs.mkdir(path.join(directory, 'album'));
			await fs.writeFile(path.join(directory, 'album', 'nested.mp3'), 'not-real-audio');
			await fs.mkdir(path.join(directory, '.saru2radio-cache', 'tracks'), { recursive: true });
			await fs.writeFile(path.join(directory, '.saru2radio-cache', 'tracks', 'cached.mp3'), 'not-real-audio');

			const manager = new LibraryManager(null);
			const rootOnly = await manager.scan(directory, { recursive: false });
			expect(rootOnly.tracks.map((track) => track.fileName)).toEqual(['root.mp3']);

			const recursive = await manager.scan(directory);
			expect(recursive.tracks.map((track) => track.fileName).sort()).toEqual(['nested.mp3', 'root.mp3']);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects cache folders as preparation sources while keeping them valid for broadcast scans', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-cache-source-guard-'));
		const cacheDirectory = path.join(directory, '.saru2radio-cache');
		const tracksDirectory = path.join(cacheDirectory, 'tracks');

		try {
			await fs.mkdir(tracksDirectory, { recursive: true });
			await fs.writeFile(path.join(tracksDirectory, 'copy.radio.mp3'), 'prepared');

			await expect(new LibraryManager(null).scan(cacheDirectory)).rejects.toThrow('original music folder');
			await expect(new LibraryManager(null).scan(tracksDirectory)).rejects.toThrow('original music folder');

			const broadcast = await new LibraryManager(null).scanBroadcast(tracksDirectory);
			expect(broadcast).toMatchObject({
				sourceKind: 'cache-tracks',
				tracks: [{ fileName: 'copy.radio.mp3', cacheReady: true }]
			});
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('scans a ready-to-air MP3 folder without requiring cache preparation', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-ready-'));

		try {
			await fs.writeFile(path.join(directory, 'root.mp3'), 'not-real-audio');
			await fs.mkdir(path.join(directory, 'album'));
			await fs.writeFile(path.join(directory, 'album', 'nested.mp3'), 'not-real-audio');

			const manager = new LibraryManager(null);
			const rootOnly = await manager.scanBroadcast(directory);
			expect(rootOnly.sourceKind).toBe('ready-folder');
			expect(rootOnly.tracks.map((track) => track.fileName)).toEqual(['root.mp3']);
			expect(rootOnly.tracks[0].cacheReady).toBe(true);
			expect(rootOnly.tracks[0].playPath).toBe(path.join(directory, 'root.mp3'));

			const recursive = await manager.scanBroadcast(directory, { recursive: true });
			expect(recursive.tracks.map((track) => track.fileName).sort()).toEqual(['nested.mp3', 'root.mp3']);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('scans source, cache, and tracks folders using manifest metadata', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-cache-'));

		try {
			const sourcePath = path.join(directory, 'original.mp3');
			const cacheDirectory = path.join(directory, '.saru2radio-cache');
			const tracksDirectory = path.join(cacheDirectory, 'tracks');
			const cachePath = path.join(tracksDirectory, 'abc123.radio.mp3');
			await fs.mkdir(tracksDirectory, { recursive: true });
			await fs.writeFile(sourcePath, 'original');
			await fs.writeFile(cachePath, 'radio-copy');
			await fs.writeFile(
				path.join(cacheDirectory, 'manifest.json'),
				JSON.stringify({
					version: 1,
					preset: 'sw-0.7-mp3',
					tracks: {
						track123: {
							sourcePath,
							size: 8,
							mtimeMs: 1,
							preset: 'sw-0.7-mp3',
							cachePath,
							title: 'Manifest Title',
							artist: 'Manifest Artist',
							duration: 123
						}
					}
				})
			);

			for (const input of [directory, cacheDirectory, tracksDirectory]) {
				const scanned = await new LibraryManager(null).scanBroadcast(input);
				expect(scanned.tracks).toHaveLength(1);
				expect(scanned.tracks[0]).toMatchObject({
					id: 'track123',
					title: 'Manifest Title',
					artist: 'Manifest Artist',
					duration: 123,
					sourcePath,
					playPath: cachePath,
					cacheReady: true
				});
			}
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects manifest tracks that escape through a symlink or junction', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-cache-link-'));
		const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-cache-outside-'));

		try {
			const cacheDirectory = path.join(directory, '.saru2radio-cache');
			const tracksDirectory = path.join(cacheDirectory, 'tracks');
			const linkPath = path.join(tracksDirectory, 'escape');
			const outsideTrack = path.join(outsideDirectory, 'outside.mp3');
			await fs.mkdir(tracksDirectory, { recursive: true });
			await fs.writeFile(outsideTrack, 'outside-audio');
			await fs.symlink(outsideDirectory, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
			await fs.writeFile(
				path.join(cacheDirectory, 'manifest.json'),
				JSON.stringify({
					version: 1,
					preset: 'sw-0.7-mp3',
					tracks: {
						escape: {
							sourcePath: path.join(directory, 'original.mp3'),
							size: 13,
							mtimeMs: 1,
							preset: 'sw-0.7-mp3',
							cachePath: path.join(linkPath, 'outside.mp3'),
							title: 'Outside Track',
							artist: 'Untrusted Manifest',
							duration: 60
						}
					}
				})
			);

			const scanned = await new LibraryManager(null).scanBroadcast(directory);
			expect(scanned.tracks).toEqual([]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
			await fs.rm(outsideDirectory, { recursive: true, force: true });
		}
	});

	it('persists studio state for broadcast library restore', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-state-'));
		const statePath = path.join(directory, 'studio-state.json');

		try {
			const store = new StudioStateStore(statePath);
			await store.update({
				broadcastDirectory: 'C:\\Music\\Radio',
				broadcastRecursive: true,
				ordered: true
			});

			const reloaded = new StudioStateStore(statePath);
			expect(await reloaded.load()).toMatchObject({
				broadcastDirectory: 'C:\\Music\\Radio',
				broadcastRecursive: true,
				ordered: true
			});
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
