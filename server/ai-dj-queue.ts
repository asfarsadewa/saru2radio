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
