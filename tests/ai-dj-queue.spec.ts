import { describe, expect, it } from 'vitest';
import { AiDjQueueReservations } from '../server/ai-dj-queue.js';

describe('AiDjQueueReservations', () => {
	it('keeps a human next choice ahead of listener requests while preserving listener FIFO order', () => {
		const reservations = new AiDjQueueReservations();
		reservations.markHumanNext('human-next', 'current');

		expect(
			reservations.reserveListenerTrack('first-request', 'current', [
				'current',
				'human-next',
				'first-request',
				'second-request'
			])
		).toEqual(['human-next', 'first-request']);
		expect(
			reservations.reserveListenerTrack('second-request', 'current', [
				'current',
				'human-next',
				'first-request',
				'second-request'
			])
		).toEqual(['human-next', 'first-request', 'second-request']);
	});

	it('does not duplicate requests or let a later repeat jump the queue', () => {
		const reservations = new AiDjQueueReservations();
		reservations.reserveListenerTrack('first-request', 'current', ['current', 'first-request', 'second-request']);
		reservations.reserveListenerTrack('second-request', 'current', ['current', 'first-request', 'second-request']);

		expect(
			reservations.reserveListenerTrack('first-request', 'current', ['current', 'first-request', 'second-request'])
		).toEqual(['first-request', 'second-request']);
	});

	it('releases completed reservations and lets a later human choice take priority', () => {
		const reservations = new AiDjQueueReservations();
		reservations.reserveListenerTrack('first-request', 'current', ['current', 'first-request', 'second-request']);
		reservations.reserveListenerTrack('second-request', 'current', ['current', 'first-request', 'second-request']);
		reservations.markTrackStarted('first-request');
		reservations.markHumanNext('second-request', 'first-request');

		expect(
			reservations.reserveListenerTrack('third-request', 'first-request', [
				'first-request',
				'second-request',
				'third-request'
			])
		).toEqual(['second-request', 'third-request']);
	});
});
