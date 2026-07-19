import { Mp3Encoder } from '@breezystack/lamejs';
import { TARGET_SAMPLE_RATE } from './audioConstants.js';

export { TARGET_SAMPLE_RATE } from './audioConstants.js';
const FRAME_SIZE = 1152;

export class LiveMp3Encoder {
	private readonly encoder: Mp3Encoder;
	private readonly resampler: StreamingResampler | null;
	private pending: number[] = [];

	constructor(sourceSampleRate: number, bitrateKbps: number) {
		this.resampler =
			sourceSampleRate === TARGET_SAMPLE_RATE ? null : new StreamingResampler(sourceSampleRate, TARGET_SAMPLE_RATE);
		this.encoder = new Mp3Encoder(1, TARGET_SAMPLE_RATE, bitrateKbps);
	}

	encode(input: Float32Array): ArrayBuffer[] {
		const resampled = this.resampler ? this.resampler.process(input) : input;

		for (const sample of resampled) {
			this.pending.push(toPcm16(sample));
		}

		const chunks: ArrayBuffer[] = [];

		while (this.pending.length >= FRAME_SIZE) {
			const frame = new Int16Array(this.pending.splice(0, FRAME_SIZE));
			const encoded = this.encoder.encodeBuffer(frame);
			if (encoded.length > 0) {
				chunks.push(copyBytes(encoded));
			}
		}

		return chunks;
	}

	flush(): ArrayBuffer[] {
		const chunks: ArrayBuffer[] = [];

		if (this.pending.length > 0) {
			const encoded = this.encoder.encodeBuffer(new Int16Array(this.pending));
			if (encoded.length > 0) {
				chunks.push(copyBytes(encoded));
			}
			this.pending = [];
		}

		const flushed = this.encoder.flush();
		if (flushed.length > 0) {
			chunks.push(copyBytes(flushed));
		}

		return chunks;
	}
}

export class StreamingResampler {
	private readonly step: number;
	private tail = new Float32Array(0);
	private position = 0;

	constructor(sourceSampleRate: number, targetSampleRate: number) {
		this.step = sourceSampleRate / targetSampleRate;
	}

	process(input: Float32Array): Float32Array {
		const samples = concatFloat32(this.tail, input);
		if (samples.length < 2) {
			this.tail = new Float32Array(samples);
			return new Float32Array(0);
		}

		const capacity = Math.max(0, Math.ceil((samples.length - 1 - this.position) / this.step));
		const output = new Float32Array(capacity);
		let written = 0;
		let cursor = this.position;

		while (cursor + 1 < samples.length) {
			const index = Math.floor(cursor);
			const fraction = cursor - index;
			const current = samples[index] ?? 0;
			const next = samples[index + 1] ?? current;
			output[written] = current + (next - current) * fraction;
			written += 1;
			cursor += this.step;
		}

		const keepFrom = Math.max(0, Math.floor(cursor));
		this.tail = new Float32Array(samples.slice(keepFrom));
		this.position = cursor - keepFrom;
		return written === output.length ? output : output.slice(0, written);
	}

	get bufferedSourceSamples(): number {
		return this.tail.length;
	}
}

function concatFloat32(left: Float32Array, right: Float32Array): Float32Array {
	if (left.length === 0) {
		return right;
	}

	const output = new Float32Array(left.length + right.length);
	output.set(left, 0);
	output.set(right, left.length);
	return output;
}

function toPcm16(sample: number): number {
	const clamped = Math.min(1, Math.max(-1, sample));
	return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}
