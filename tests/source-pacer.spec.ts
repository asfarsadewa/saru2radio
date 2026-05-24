import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceStreamPacer } from '../server/source-pacer.js';

function createWriter() {
	const chunks: Buffer[] = [];
	return {
		chunks,
		writer: {
			write(chunk: Buffer) {
				chunks.push(Buffer.from(chunk));
			}
		}
	};
}

describe('SourceStreamPacer', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('waits for the live prebuffer before draining at the target bitrate', () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { chunks, writer } = createWriter();
		const pacer = new SourceStreamPacer(writer, 64, {
			tickMs: 100,
			prebufferSeconds: 1,
			maxWaitMs: 5000,
			minBytesPerTick: 0
		});

		pacer.push(Buffer.alloc(7_999, 1));
		vi.advanceTimersByTime(1000);
		expect(chunks).toHaveLength(0);

		pacer.push(Buffer.alloc(1, 1));
		vi.advanceTimersByTime(100);
		expect(Buffer.concat(chunks)).toHaveLength(800);

		pacer.stop();
	});

	it('starts draining after the max wait even when the prebuffer is not full', () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { chunks, writer } = createWriter();
		const pacer = new SourceStreamPacer(writer, 64, {
			tickMs: 100,
			prebufferSeconds: 10,
			maxWaitMs: 500,
			minBytesPerTick: 0
		});

		pacer.push(Buffer.alloc(1_600, 1));
		vi.advanceTimersByTime(400);
		expect(chunks).toHaveLength(0);

		vi.advanceTimersByTime(100);
		expect(Buffer.concat(chunks)).toHaveLength(800);

		pacer.stop();
	});
});
