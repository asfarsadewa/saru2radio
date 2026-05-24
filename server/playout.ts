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

export class DirectMp3Playout {
	private running = false;
	private skipRequested = false;
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
		this.running = true;
		this.skipRequested = false;
		this.token += 1;
		const token = this.token;
		this.source.connect();
		void this.run(token, queue).catch((error) => {
			if (token !== this.token) {
				return;
			}
			this.running = false;
			this.source.disconnect();
			this.callbacks.onError(error instanceof Error ? error.message : 'Direct MP3 playout failed.');
			this.callbacks.onStop();
		});
	}

	stop(disconnect = true): void {
		this.running = false;
		this.skipRequested = true;
		this.token += 1;
		if (disconnect) {
			this.source.disconnect();
		}
	}

	skip(): void {
		this.skipRequested = true;
	}

	isRunning(): boolean {
		return this.running;
	}

	private async run(token: number, queue: Track[]): Promise<void> {
		let index = 0;
		while (this.running && token === this.token) {
			const track = queue[index % queue.length];
			if (!track) {
				break;
			}

			this.callbacks.onTrack(track);
			await this.streamTrack(track, token);
			this.skipRequested = false;
			index += 1;
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
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
				if (bytesRead === 0) {
					return;
				}

				this.source.write(buffer.subarray(0, bytesRead));
				dueAt += (bytesRead / bytesPerSecond) * 1000;
				await delay(Math.max(0, dueAt - Date.now()));
			}
		} finally {
			await handle.close();
		}
	}
}

export function estimatePacedBytesPerSecond(fileSize: number, durationSeconds: number | null): number {
	if (durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 1 && fileSize > 0) {
		return fileSize / durationSeconds;
	}

	return FALLBACK_BYTES_PER_SECOND;
}
