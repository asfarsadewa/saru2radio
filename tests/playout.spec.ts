import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AiDjQueueCoordinator } from '../server/ai-dj-queue.js';
import { calculatePlayoutDelayMs, DirectMp3Playout, estimatePacedBytesPerSecond, findCurrentTrackIndex } from '../server/playout.js';
import type { Track } from '../src/lib/types.js';

let tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })));
	tempDirs = [];
});

class FakeSource {
	connectCalls = 0;
	disconnectCalls = 0;
	chunks: Buffer[] = [];

	connect(): void {
		this.connectCalls += 1;
	}

	disconnect(): void {
		this.disconnectCalls += 1;
	}

	write(chunk: Buffer): void {
		this.chunks.push(Buffer.from(chunk));
	}
}

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

	it('finds the current track in a replacement direct queue', async () => {
		const first = await createTrack('first');
		const second = await createTrack('second');

		expect(findCurrentTrackIndex([first, second], 'second')).toBe(1);
		expect(findCurrentTrackIndex([first, second], 'missing')).toBe(-1);
	});

	it('switches to an ad-hoc direct queue without reconnecting the source', async () => {
		const source = new FakeSource();
		const first = await createTrack('first');
		const second = await createTrack('second');
		const seenTracks: string[] = [];
		const errors: string[] = [];
		const playout = new DirectMp3Playout(source as never, {
			onTrack: (track) => seenTracks.push(track.id),
			onStop: () => {},
			onError: (message) => errors.push(message)
		});

		playout.start([first]);
		expect(source.connectCalls).toBe(1);
		expect(seenTracks[0]).toBe('first');

		playout.playNow([second, first]);
		expect(source.connectCalls).toBe(1);

		await waitFor(() => seenTracks.includes('second'));
		playout.stop();

		expect(source.disconnectCalls).toBe(1);
		expect(errors).toEqual([]);
	});

	it('queues a requested track after the actual current direct-playout track', async () => {
		const source = new FakeSource();
		const first = await createTrack('first');
		const second = await createTrack('second');
		const requested = await createTrack('requested');
		const seenTracks: string[] = [];
		const playout = new DirectMp3Playout(source as never, {
			onTrack: (track) => seenTracks.push(track.id),
			onStop: () => {},
			onError: () => {}
		});

		playout.start([first, second, requested]);
		expect(seenTracks[0]).toBe('first');

		expect(playout.queueNext(requested).map((track) => track.id)).toEqual(['first', 'requested', 'second']);
		playout.setQueue([second, requested, first]);
		expect(playout.queueNext(second).map((track) => track.id)).toEqual(['requested', 'first', 'second']);
		expect(source.connectCalls).toBe(1);
		playout.stop();
	});

	it('preserves an ordered block of human and listener requests after the current track', async () => {
		const source = new FakeSource();
		const current = await createTrack('current');
		const ordinaryNext = await createTrack('ordinary-next');
		const humanNext = await createTrack('human-next');
		const firstRequest = await createTrack('first-request');
		const secondRequest = await createTrack('second-request');
		const playout = new DirectMp3Playout(source as never, {
			onTrack: () => {},
			onStop: () => {},
			onError: () => {}
		});

		playout.start([current, ordinaryNext, humanNext, firstRequest, secondRequest]);
		expect(playout.queueAfterCurrent([humanNext, firstRequest, secondRequest]).map((track) => track.id)).toEqual([
			'current',
			'human-next',
			'first-request',
			'second-request',
			'ordinary-next'
		]);
		expect(playout.queueAfterCurrent([humanNext, firstRequest, firstRequest, secondRequest]).map((track) => track.id)).toEqual([
			'current',
			'human-next',
			'first-request',
			'second-request',
			'ordinary-next'
		]);
		playout.stop();
	});

	it('preserves human priority and listener FIFO across a routine queue replacement', async () => {
		const source = new FakeSource();
		const current = await createTrack('current');
		const ordinary = await createTrack('ordinary');
		const humanNext = await createTrack('human-next');
		const firstRequest = await createTrack('first-request');
		const secondRequest = await createTrack('second-request');
		const thirdRequest = await createTrack('third-request');
		const playedWhenIdle: string[] = [];
		const playout = new DirectMp3Playout(source as never, {
			onTrack: () => {},
			onStop: () => {},
			onError: () => {}
		});
		const coordinator = new AiDjQueueCoordinator(playout, async (track) => {
			playedWhenIdle.push(track.id);
		});

		playout.start([current, ordinary, humanNext, firstRequest, secondRequest, thirdRequest]);
		playout.pause();
		coordinator.queueHumanNext(humanNext);
		expect(await coordinator.schedule(firstRequest)).toEqual({ disposition: 'queued', queuePosition: 2 });
		expect(await coordinator.schedule(secondRequest)).toEqual({ disposition: 'queued', queuePosition: 3 });

		expect(
			coordinator
				.replaceQueue([current, thirdRequest, ordinary, secondRequest, humanNext, firstRequest])
				.map((track) => track.id)
		).toEqual(['current', 'human-next', 'first-request', 'second-request', 'third-request', 'ordinary']);
		expect(await coordinator.schedule(thirdRequest)).toEqual({ disposition: 'queued', queuePosition: 4 });
		expect(playout.getQueue().map((track) => track.id)).toEqual([
			'current',
			'human-next',
			'first-request',
			'second-request',
			'third-request',
			'ordinary'
		]);
		expect(playedWhenIdle).toEqual([]);
		playout.stop();
	});

	it('queues after the audible track even when a replacement queue omits that track', async () => {
		const source = new FakeSource();
		const current = await createTrack('current');
		const ordinary = await createTrack('ordinary');
		const requested = await createTrack('requested');
		const playedWhenIdle: string[] = [];
		const playout = new DirectMp3Playout(source as never, {
			onTrack: () => {},
			onStop: () => {},
			onError: () => {}
		});
		const coordinator = new AiDjQueueCoordinator(playout, async (track) => {
			playedWhenIdle.push(track.id);
		});

		playout.start([current, ordinary, requested]);
		playout.pause();
		coordinator.replaceQueue([ordinary, requested]);

		expect(playout.getActiveTrack()?.id).toBe('current');
		expect(await coordinator.schedule(requested)).toEqual({ disposition: 'queued_next', queuePosition: 1 });
		expect(playout.getQueue().map((track) => track.id)).toEqual(['requested', 'ordinary']);
		expect(playedWhenIdle).toEqual([]);
		playout.stop();
	});

	it('keeps an explicit play-now target ahead of a concurrent listener request', async () => {
		const source = new FakeSource();
		const current = await createTrack('current');
		const playNowTrack = await createTrack('play-now');
		const ordinary = await createTrack('ordinary');
		const requested = await createTrack('requested');
		const seenTracks: string[] = [];
		const playout = new DirectMp3Playout(source as never, {
			onTrack: (track) => seenTracks.push(track.id),
			onStop: () => {},
			onError: () => {}
		});
		const coordinator = new AiDjQueueCoordinator(playout, async () => {});

		playout.start([current, ordinary]);
		playout.pause();
		playout.playNow([playNowTrack, ordinary, requested]);

		expect(await coordinator.schedule(requested)).toEqual({ disposition: 'queued', queuePosition: 2 });
		expect(playout.getQueue().map((track) => track.id)).toEqual(['play-now', 'requested', 'ordinary']);

		playout.resume();
		await waitFor(() => seenTracks.includes('play-now'));
		expect(seenTracks.slice(0, 2)).toEqual(['current', 'play-now']);
		playout.stop();
	});

	it('starts a request immediately only when playout is genuinely idle', async () => {
		const source = new FakeSource();
		const requested = await createTrack('requested');
		const playedWhenIdle: string[] = [];
		const playout = new DirectMp3Playout(source as never, {
			onTrack: () => {},
			onStop: () => {},
			onError: () => {}
		});
		const coordinator = new AiDjQueueCoordinator(playout, async (track) => {
			playedWhenIdle.push(track.id);
		});

		expect(await coordinator.schedule(requested)).toEqual({ disposition: 'played_now' });
		expect(playedWhenIdle).toEqual(['requested']);
	});
});

async function createTrack(id: string): Promise<Track> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), `saru2radio-${id}-`));
	tempDirs.push(directory);
	const cachePath = path.join(directory, `${id}.radio.mp3`);
	await fs.writeFile(cachePath, Buffer.alloc(2048, id.charCodeAt(0)));

	return {
		id,
		sourcePath: cachePath,
		playPath: cachePath,
		fileName: `${id}.mp3`,
		title: id,
		artist: 'Test',
		duration: null,
		size: 2048,
		mtimeMs: Date.now(),
		cachePath,
		cacheReady: true,
		cacheStale: false
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error('Timed out waiting for direct playout state.');
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
