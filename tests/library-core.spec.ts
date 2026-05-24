import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	cacheFileName,
	createTrackId,
	isCacheFresh,
	isSupportedAudio,
	radioPresetKey,
	stableTrackSeed
} from '../server/library-core.js';

describe('library-core', () => {
	it('detects supported audio files case-insensitively', () => {
		expect(isSupportedAudio('song.MP3')).toBe(true);
		expect(isSupportedAudio('voice.flac')).toBe(true);
		expect(isSupportedAudio('cover.jpg')).toBe(false);
	});

	it('creates stable ids, seeds, and cache filenames from paths', () => {
		const source = path.join('C:', 'Music', 'A Song.mp3');
		expect(createTrackId(source)).toHaveLength(16);
		expect(createTrackId(source)).toBe(createTrackId(source));
		expect(stableTrackSeed(source)).toBe(stableTrackSeed(source));
		expect(cacheFileName(source)).toMatch(/^[a-f0-9]{16}\.radio\.mp3$/);
	});

	it('only reuses cache entries with matching source metadata and preset', () => {
		const source = {
			sourcePath: path.join('C:', 'Music', 'A Song.mp3'),
			size: 1234,
			mtimeMs: 4567
		};
		const entry = {
			...source,
			preset: radioPresetKey()
		};

		expect(isCacheFresh(entry, source)).toBe(true);
		expect(isCacheFresh({ ...entry, size: 9999 }, source)).toBe(false);
		expect(isCacheFresh({ ...entry, preset: 'am-0.6-mp3' }, source)).toBe(false);
	});
});
