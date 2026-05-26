import { describe, expect, it } from 'vitest';
import { createPlaybackQueue, cueTrackInQueue, reconcileQueueWithTracks, rotateQueueToTrack } from '../src/lib/queue.js';

const tracks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

describe('queue helpers', () => {
	it('rotates ordered queues from the current track instead of moving it over the sequence', () => {
		expect(createPlaybackQueue(tracks, true, 'c').map((track) => track.id)).toEqual(['c', 'd', 'a', 'b']);
	});

	it('preserves shuffled queue order when cueing an ad-hoc track', () => {
		const shuffledQueue = [tracks[2], tracks[0], tracks[3], tracks[1]];

		expect(cueTrackInQueue(tracks[0], tracks, shuffledQueue, false).map((track) => track.id)).toEqual(['a', 'd', 'b', 'c']);
	});

	it('keeps the displayed queue aligned with the current now-playing track', () => {
		expect(rotateQueueToTrack(tracks, 'b').map((track) => track.id)).toEqual(['b', 'c', 'd', 'a']);
	});

	it('reconciles a displayed queue against refreshed ready tracks without resetting its order', () => {
		const refreshedTracks = [{ id: 'a' }, { id: 'b' }, { id: 'd' }, { id: 'e' }];
		const queue = [tracks[2], tracks[0], tracks[3], tracks[1]];

		expect(reconcileQueueWithTracks(queue, refreshedTracks, true).map((track) => track.id)).toEqual(['a', 'd', 'b', 'e']);
	});
});
