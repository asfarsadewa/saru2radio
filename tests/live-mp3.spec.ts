import { describe, expect, it } from 'vitest';
import { parseBuffer } from 'music-metadata';
import { LiveMp3Encoder, StreamingResampler, TARGET_SAMPLE_RATE } from '../src/lib/audio/liveMp3.js';

describe('LiveMp3Encoder', () => {
	it('produces a valid mono MP3 from worklet-sized and irregular PCM chunks', async () => {
		const sourceRate = 48_000;
		const durationSeconds = 3;
		const input = new Float32Array(sourceRate * durationSeconds);
		for (let index = 0; index < input.length; index += 1) {
			input[index] = Math.sin((index / sourceRate) * Math.PI * 2 * 440) * 0.5;
		}

		const encoder = new LiveMp3Encoder(sourceRate, 128);
		const chunks: ArrayBuffer[] = [];
		const chunkSizes = [128, 2048, 511, 4096];
		let offset = 0;
		let chunkIndex = 0;
		while (offset < input.length) {
			const size = chunkSizes[chunkIndex % chunkSizes.length] ?? 128;
			chunks.push(...encoder.encode(input.subarray(offset, Math.min(input.length, offset + size))));
			offset += size;
			chunkIndex += 1;
		}
		chunks.push(...encoder.flush());

		const encoded = concatenate(chunks);
		const metadata = await parseBuffer(encoded, { mimeType: 'audio/mpeg', size: encoded.byteLength }, { duration: true });
		expect(metadata.format).toMatchObject({
			container: 'MPEG',
			codec: 'MPEG 2 Layer 3',
			sampleRate: TARGET_SAMPLE_RATE,
			numberOfChannels: 1,
			bitrate: 128_000
		});
		expect(metadata.format.duration).toBeGreaterThan(durationSeconds - 0.1);
		expect(metadata.format.duration).toBeLessThan(durationSeconds + 0.2);
	});
});

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

function concatenate(chunks: ArrayBuffer[]): Uint8Array {
	const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(new Uint8Array(chunk), offset);
		offset += chunk.byteLength;
	}
	return output;
}
