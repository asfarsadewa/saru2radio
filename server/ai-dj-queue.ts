import type { Track } from '../src/lib/types.js';
import type { AiDjTrackScheduleResult } from './ai-dj.js';

type AiDjQueuePlayout = {
	getActiveTrack(): Track | null;
	getQueue(): Track[];
	queueAfterCurrent(tracks: Track[]): Track[];
	queueNext(track: Track): Track[];
	setQueue(queue: Track[]): void;
};

export class AiDjQueueReservations {
	private humanNextTrackId: string | null = null;
	private listenerTrackIds: string[] = [];

	reserveListenerTrack(trackId: string, currentTrackId: string, queueTrackIds: string[]): string[] {
		this.reconcile(currentTrackId, queueTrackIds);
		if (
			trackId !== currentTrackId &&
			trackId !== this.humanNextTrackId &&
			!this.listenerTrackIds.includes(trackId)
		) {
			this.listenerTrackIds.push(trackId);
		}
		return this.orderedTrackIds();
	}

	markHumanNext(trackId: string, currentTrackId: string | null): void {
		if (trackId === currentTrackId) {
			return;
		}
		this.humanNextTrackId = trackId;
		this.listenerTrackIds = this.listenerTrackIds.filter((listenerTrackId) => listenerTrackId !== trackId);
	}

	markTrackStarted(trackId: string): void {
		if (this.humanNextTrackId === trackId) {
			this.humanNextTrackId = null;
		}
		this.listenerTrackIds = this.listenerTrackIds.filter((listenerTrackId) => listenerTrackId !== trackId);
	}

	reconcileQueue(currentTrackId: string | null, queueTrackIds: string[]): string[] {
		if (!currentTrackId) {
			this.reset();
			return [];
		}
		this.reconcile(currentTrackId, queueTrackIds);
		return this.orderedTrackIds();
	}

	reset(): void {
		this.humanNextTrackId = null;
		this.listenerTrackIds = [];
	}

	private reconcile(currentTrackId: string, queueTrackIds: string[]): void {
		const queued = new Set(queueTrackIds);
		if (
			this.humanNextTrackId === currentTrackId ||
			!this.humanNextTrackId ||
			!queued.has(this.humanNextTrackId)
		) {
			this.humanNextTrackId = null;
		}

		const seen = new Set<string>();
		this.listenerTrackIds = this.listenerTrackIds.filter((trackId) => {
			if (
				trackId === currentTrackId ||
				trackId === this.humanNextTrackId ||
				seen.has(trackId) ||
				!queued.has(trackId)
			) {
				return false;
			}
			seen.add(trackId);
			return true;
		});
	}

	private orderedTrackIds(): string[] {
		return [this.humanNextTrackId, ...this.listenerTrackIds].filter(
			(trackId): trackId is string => Boolean(trackId)
		);
	}
}

export class AiDjQueueCoordinator {
	private readonly reservations = new AiDjQueueReservations();

	constructor(
		private readonly playout: AiDjQueuePlayout,
		private readonly playWhenIdle: (track: Track) => Promise<void>
	) {}

	async schedule(track: Track): Promise<AiDjTrackScheduleResult> {
		const activeTrack = this.playout.getActiveTrack();
		if (!activeTrack) {
			this.reservations.reset();
			await this.playWhenIdle(track);
			return { disposition: 'played_now' };
		}
		if (track.id === activeTrack.id) {
			return { disposition: 'already_playing', queuePosition: 0 };
		}

		const reservedTrackIds = this.reservations.reserveListenerTrack(
			track.id,
			activeTrack.id,
			this.playout.getQueue().map((candidate) => candidate.id)
		);
		const queue = this.applyReservations(reservedTrackIds, [track]);
		const currentIndex = queue.findIndex((candidate) => candidate.id === activeTrack.id);
		const requestedIndex = queue.findIndex((candidate) => candidate.id === track.id);
		const queuePosition = currentIndex >= 0 ? requestedIndex - currentIndex : requestedIndex + 1;
		if (requestedIndex < 0 || queuePosition <= 0) {
			throw new Error('AI DJ could not place the requested song after the current track.');
		}

		return {
			disposition: queuePosition === 1 ? 'queued_next' : 'queued',
			queuePosition
		};
	}

	queueHumanNext(track: Track): Track[] {
		const queue = this.playout.queueNext(track);
		this.reservations.markHumanNext(track.id, this.playout.getActiveTrack()?.id ?? null);
		return queue;
	}

	replaceQueue(queue: Track[]): Track[] {
		this.playout.setQueue(queue);
		const reservedTrackIds = this.reservations.reconcileQueue(
			this.playout.getActiveTrack()?.id ?? null,
			queue.map((track) => track.id)
		);
		return this.applyReservations(reservedTrackIds);
	}

	markTrackStarted(trackId: string): void {
		this.reservations.markTrackStarted(trackId);
	}

	reset(): void {
		this.reservations.reset();
	}

	private applyReservations(trackIds: string[], additionalTracks: Track[] = []): Track[] {
		if (trackIds.length === 0) {
			return this.playout.getQueue();
		}

		const tracksById = new Map(this.playout.getQueue().map((track) => [track.id, track]));
		for (const track of additionalTracks) {
			tracksById.set(track.id, track);
		}
		const reservedTracks = trackIds
			.map((trackId) => tracksById.get(trackId))
			.filter((track): track is Track => Boolean(track?.cacheReady));
		return reservedTracks.length > 0
			? this.playout.queueAfterCurrent(reservedTracks)
			: this.playout.getQueue();
	}
}
