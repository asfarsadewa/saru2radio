import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibraryManager } from '../server/library.js';

describe('LibraryManager', () => {
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
});
