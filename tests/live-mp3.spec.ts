import { describe, expect, it } from 'vitest';
import { StreamingResampler, TARGET_SAMPLE_RATE } from '../src/lib/audio/liveMp3.js';

describe('StreamingResampler', () => {
	it('keeps sample-rate conversion continuous across browser audio chunks', () => {
		const sourceRate = 48_000;
		const chunkLength = 4096;
		const chunks = 100;
		const resampler = new StreamingResampler(sourceRate, TARGET_SAMPLE_RATE);
		let outputSamples = 0;

		for (let chunk = 0; chunk < chunks; chunk += 1) {
			const input = new Float32Array(chunkLength);
			for (let index = 0; index < input.length; index += 1) {
				input[index] = Math.sin(((chunk * chunkLength + index) / sourceRate) * Math.PI * 2 * 440);
			}
			outputSamples += resampler.process(input).length;
		}

		const expected = Math.floor((chunkLength * chunks * TARGET_SAMPLE_RATE) / sourceRate);
		expect(Math.abs(outputSamples - expected)).toBeLessThanOrEqual(1);
		expect(resampler.bufferedSourceSamples).toBeLessThanOrEqual(2);
	});
});
