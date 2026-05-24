import { describe, expect, it } from 'vitest';
import { estimatePacedBytesPerSecond } from '../server/playout.js';

describe('DirectMp3Playout', () => {
	it('paces cached MP3 files from their converted size and track duration', () => {
		expect(estimatePacedBytesPerSecond(3_200_000, 200)).toBe(16_000);
		expect(estimatePacedBytesPerSecond(0, 200)).toBe(16_000);
		expect(estimatePacedBytesPerSecond(3_200_000, null)).toBe(16_000);
	});
});
