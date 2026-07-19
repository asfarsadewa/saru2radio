import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LiveMp3Encoder } from '../../src/lib/audio/liveMp3.js';

const runtimeDir = path.resolve(process.env.SARU2RADIO_RUNTIME_DIR ?? '.codex-runtime/e2e-runtime');
const fixtureDir = path.resolve(process.env.SARU2RADIO_E2E_FIXTURE_DIR ?? '.codex-runtime/e2e-fixtures');
const mp3Path = path.join(fixtureDir, 'steady-tone.mp3');
const wavPath = path.join(fixtureDir, 'fake-microphone.wav');

await fs.mkdir(runtimeDir, { recursive: true });
await fs.mkdir(fixtureDir, { recursive: true });
await Promise.all([
	fs.writeFile(mp3Path, createMp3Tone()),
	fs.writeFile(wavPath, createWavTone()),
	fs.writeFile(
		path.join(runtimeDir, 'studio-state.json'),
		`${JSON.stringify(
			{
				version: 1,
				broadcastDirectory: fixtureDir,
				broadcastRecursive: false,
				ordered: true,
				prepDirectory: '',
				updatedAt: new Date().toISOString()
			},
			null,
			2
		)}\n`
	)
]);

function createMp3Tone(): Uint8Array {
	const sampleRate = 22_050;
	const durationSeconds = 15;
	const encoder = new LiveMp3Encoder(sampleRate, 128);
	const encoded: ArrayBuffer[] = [];
	const chunk = new Float32Array(2048);
	let generated = 0;
	while (generated < sampleRate * durationSeconds) {
		const length = Math.min(chunk.length, sampleRate * durationSeconds - generated);
		for (let index = 0; index < length; index += 1) {
			chunk[index] = Math.sin(((generated + index) / sampleRate) * Math.PI * 2 * 440) * 0.42;
		}
		encoded.push(...encoder.encode(chunk.subarray(0, length)));
		generated += length;
	}
	encoded.push(...encoder.flush());
	return concatenate(encoded);
}

function createWavTone(): Uint8Array {
	const sampleRate = 48_000;
	const durationSeconds = 30;
	const samples = sampleRate * durationSeconds;
	const output = new Uint8Array(44 + samples * 2);
	const view = new DataView(output.buffer);
	writeAscii(output, 0, 'RIFF');
	view.setUint32(4, output.byteLength - 8, true);
	writeAscii(output, 8, 'WAVE');
	writeAscii(output, 12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(output, 36, 'data');
	view.setUint32(40, samples * 2, true);
	for (let index = 0; index < samples; index += 1) {
		view.setInt16(44 + index * 2, Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 880) * 0x3fff), true);
	}
	return output;
}

function concatenate(chunks: ArrayBuffer[]): Uint8Array {
	const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(new Uint8Array(chunk), offset);
		offset += chunk.byteLength;
	}
	return output;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
	for (let index = 0; index < value.length; index += 1) {
		target[offset + index] = value.charCodeAt(index);
	}
}
