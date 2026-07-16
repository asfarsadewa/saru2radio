import { promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { Track } from '../src/lib/types.js';
import type { IcecastSourceConnection } from './icecast.js';

type PlayoutCallbacks = {
	onTrack(track: Track): void;
	onStop(): void;
	onError(message: string): void;
};

const FALLBACK_BYTES_PER_SECOND = 16_000;
const CHUNK_SIZE = 4096;
const SOURCE_LEAD_MS = 500;

export class DirectMp3Playout {
	private running = false;
	private skipRequested = false;
	private paused = false;
	private pauseStartedAt = 0;
	private pauseDebtMs = 0;
	private resumeWaiters: Array<() => void> = [];
	private queue: Track[] = [];
	private currentIndex = 0;
	private switchRequested = false;
	private token = 0;

	constructor(
		private readonly source: IcecastSourceConnection,
		private readonly callbacks: PlayoutCallbacks
	) {}

	start(queue: Track[]): void {
		if (queue.length === 0) {
			throw new Error('Prepare at least one radio copy before going on air.');
		}

		this.stop(false);
		this.queue = queue;
		this.currentIndex = 0;
		this.running = true;
		this.skipRequested = false;
		this.switchRequested = false;
		this.paused = false;
		this.pauseStartedAt = 0;
		this.pauseDebtMs = 0;
		this.token += 1;
		const token = this.token;
		this.source.connect();
		void this.run(token).catch((error) => {
			if (token !== this.token) {
				return;
			}
			this.running = false;
			this.source.disconnect();
			this.callbacks.onError(error instanceof Error ? error.message : 'Direct MP3 playout failed.');
			this.callbacks.onStop();
		});
	}

	playNow(queue: Track[]): void {
		if (queue.length === 0) {
			throw new Error('Prepare at least one radio copy before going on air.');
		}

		if (!this.running) {
			this.start(queue);
			return;
		}

		this.queue = queue;
		this.currentIndex = 0;
		this.switchRequested = true;
		this.skipRequested = true;
	}

	setQueue(queue: Track[]): void {
		if (queue.length === 0) {
			throw new Error('Prepare at least one radio copy before going on air.');
		}

		const currentTrack = this.currentTrack();
		this.queue = queue;
		this.currentIndex = currentTrack ? findCurrentTrackIndex(queue, currentTrack.id) : 0;
	}

	stop(disconnect = true): void {
		this.running = false;
		this.skipRequested = true;
		this.switchRequested = false;
		this.resumePausedLoop();
		this.token += 1;
		if (disconnect) {
			this.source.disconnect();
		}
	}

	skip(): void {
		this.skipRequested = true;
		this.switchRequested = false;
	}

	isRunning(): boolean {
		return this.running;
	}

	getQueue(): Track[] {
		return [...this.queue];
	}

	queueNext(track: Track): Track[] {
		if (!this.running) {
			throw new Error('Direct song playout is not running.');
		}

		const currentTrack = this.currentTrack();
		if (!currentTrack) {
			throw new Error('There is no current song to queue after.');
		}
		if (track.id === currentTrack.id) {
			return this.getQueue();
		}

		const withoutTrack = this.queue.filter((candidate) => candidate.id !== track.id);
		const currentIndex = withoutTrack.findIndex((candidate) => candidate.id === currentTrack.id);
		if (currentIndex < 0) {
			throw new Error('The current song is no longer in the broadcast queue.');
		}

		this.queue = [
			...withoutTrack.slice(0, currentIndex + 1),
			track,
			...withoutTrack.slice(currentIndex + 1)
		];
		this.currentIndex = currentIndex;
		return this.getQueue();
	}

	pause(): void {
		if (!this.running || this.paused) {
			return;
		}

		this.paused = true;
		this.pauseStartedAt = Date.now();
	}

	resume(): void {
		if (!this.paused) {
			return;
		}

		this.pauseDebtMs += Date.now() - this.pauseStartedAt;
		this.resumePausedLoop();
	}

	private async run(token: number): Promise<void> {
		while (this.running && token === this.token) {
			const track = this.currentTrack();
			if (!track) {
				break;
			}

			this.callbacks.onTrack(track);
			await this.streamTrack(track, token);
			this.skipRequested = false;
			if (this.switchRequested) {
				this.switchRequested = false;
			} else {
				this.currentIndex += 1;
			}
		}
	}

	private async streamTrack(track: Track, token: number): Promise<void> {
		const handle = await fs.open(track.cachePath, 'r');
		try {
			const stat = await handle.stat();
			const bytesPerSecond = estimatePacedBytesPerSecond(stat.size, track.duration);
			const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
			let dueAt = Date.now();

			while (this.running && token === this.token && !this.skipRequested) {
				const pauseMs = await this.consumePauseTime();
				if (!this.running || token !== this.token || this.skipRequested) {
					return;
				}
				dueAt += pauseMs;
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
				if (bytesRead === 0) {
					return;
				}

				this.source.write(buffer.subarray(0, bytesRead));
				dueAt += (bytesRead / bytesPerSecond) * 1000;
				await delay(calculatePlayoutDelayMs(dueAt, Date.now()));
			}
		} finally {
			await handle.close();
		}
	}

	private async consumePauseTime(): Promise<number> {
		if (this.paused) {
			await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
		}

		const pauseMs = this.pauseDebtMs;
		this.pauseDebtMs = 0;
		return pauseMs;
	}

	private resumePausedLoop(): void {
		this.paused = false;
		this.pauseStartedAt = 0;
		const waiters = this.resumeWaiters.splice(0);
		for (const resolve of waiters) {
			resolve();
		}
	}

	private currentTrack(): Track | null {
		if (this.queue.length === 0) {
			return null;
		}
		if (this.currentIndex < 0) {
			return null;
		}

		return this.queue[positiveModulo(this.currentIndex, this.queue.length)] ?? null;
	}
}

export function findCurrentTrackIndex(queue: Track[], currentTrackId: string): number {
	const index = queue.findIndex((track) => track.id === currentTrackId);
	return index >= 0 ? index : -1;
}

function positiveModulo(value: number, divisor: number): number {
	return ((value % divisor) + divisor) % divisor;
}

export function estimatePacedBytesPerSecond(fileSize: number, durationSeconds: number | null): number {
	if (durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 1 && fileSize > 0) {
		return fileSize / durationSeconds;
	}

	return FALLBACK_BYTES_PER_SECOND;
}

export function calculatePlayoutDelayMs(dueAt: number, now: number, sourceLeadMs = SOURCE_LEAD_MS): number {
	return Math.max(0, dueAt - now - sourceLeadMs);
}
