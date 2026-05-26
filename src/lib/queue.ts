export type QueueTrack = {
	id: string;
};

export function createPlaybackQueue<T extends QueueTrack>(
	tracks: T[],
	ordered: boolean,
	currentTrackId: string | null = null,
	random = Math.random
): T[] {
	const queue = ordered ? [...tracks] : shuffleTracks(tracks, random);
	return currentTrackId ? rotateQueueToTrack(queue, currentTrackId) : queue;
}

export function reconcileQueueWithTracks<T extends QueueTrack>(
	queue: T[],
	tracks: T[],
	ordered: boolean,
	random = Math.random
): T[] {
	if (queue.length === 0) {
		return createPlaybackQueue(tracks, ordered, null, random);
	}

	const tracksById = new Map(tracks.map((track) => [track.id, track]));
	const reconciled = queue.map((track) => tracksById.get(track.id)).filter((track): track is T => Boolean(track));
	const queuedIds = new Set(reconciled.map((track) => track.id));
	const additions = tracks.filter((track) => !queuedIds.has(track.id));
	return [...reconciled, ...(ordered ? additions : shuffleTracks(additions, random))];
}

export function cueTrackInQueue<T extends QueueTrack>(
	track: T,
	tracks: T[],
	queue: T[],
	ordered: boolean,
	random = Math.random
): T[] {
	if (ordered) {
		return rotateQueueToTrack(tracks, track.id);
	}

	const reconciled = reconcileQueueWithTracks(queue, tracks, ordered, random);
	const containsTrack = reconciled.some((candidate) => candidate.id === track.id);
	return rotateQueueToTrack(containsTrack ? reconciled : [track, ...reconciled], track.id);
}

export function rotateQueueToTrack<T extends QueueTrack>(queue: T[], trackId: string | null | undefined): T[] {
	if (!trackId) {
		return queue;
	}

	const index = queue.findIndex((track) => track.id === trackId);
	if (index <= 0) {
		return queue;
	}

	return [...queue.slice(index), ...queue.slice(0, index)];
}

export function shuffleTracks<T>(tracks: T[], random = Math.random): T[] {
	const copy = [...tracks];
	for (let index = copy.length - 1; index > 0; index -= 1) {
		const next = Math.floor(random() * (index + 1));
		[copy[index], copy[next]] = [copy[next], copy[index]];
	}
	return copy;
}
