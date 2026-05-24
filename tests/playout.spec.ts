import { describe, expect, it } from 'vitest';
import { calculatePlayoutDelayMs, estimatePacedBytesPerSecond } from '../server/playout.js';

describe('DirectMp3Playout', () => {
	it('paces cached MP3 files from their converted size and track duration', () => {
		expect(estimatePacedBytesPerSecond(3_200_000, 200)).toBe(16_000);
		expect(estimatePacedBytesPerSecond(0, 200)).toBe(16_000);
		expect(estimatePacedBytesPerSecond(3_200_000, null)).toBe(16_000);
	});

	it('keeps a source lead before waiting between playout writes', () => {
		expect(calculatePlayoutDelayMs(10_000, 8_000, 3_000)).toBe(0);
		expect(calculatePlayoutDelayMs(12_500, 8_000, 3_000)).toBe(1500);
	});
});
