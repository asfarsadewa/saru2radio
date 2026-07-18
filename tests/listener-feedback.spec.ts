import { describe, expect, it } from 'vitest';
import { feedbackForAiDjAction, ListenerFeedbackStore } from '../server/listener-feedback.js';
import type { AiDjAction } from '../src/lib/types.js';

describe('ListenerFeedbackStore', () => {
	it('authorizes only the opaque token issued for one request', () => {
		let tokenIndex = 0;
		const store = new ListenerFeedbackStore({
			createToken: () => `token-${++tokenIndex}`
		});

		const firstToken = store.issue('request-1');
		const secondToken = store.issue('request-2');

		expect(store.authorize('request-1', firstToken)).toBe(true);
		expect(store.authorize('request-1', secondToken)).toBe(false);
		expect(store.authorize('request-2', firstToken)).toBe(false);
		expect(store.authorize('missing', firstToken)).toBe(false);
	});

	it('expires old receipts and caps retained request sessions', () => {
		let now = 1000;
		let tokenIndex = 0;
		const store = new ListenerFeedbackStore({
			maxReceipts: 2,
			ttlMs: 100,
			now: () => now,
			createToken: () => `token-${++tokenIndex}`
		});

		const firstToken = store.issue('request-1');
		const secondToken = store.issue('request-2');
		store.issue('request-3');

		expect(store.authorize('request-1', firstToken)).toBe(false);
		expect(store.authorize('request-2', secondToken)).toBe(true);

		now += 101;
		expect(store.authorize('request-2', secondToken)).toBe(false);
	});
});

describe('AI DJ listener feedback', () => {
	it('returns a private unavailable reply only for a valid missing-song decision', () => {
		expect(
			feedbackForAiDjAction(
				createAction({
					status: 'ignored_unavailable',
					decision: 'song_unavailable',
					reason: 'No local match.'
				})
			)
		).toEqual({
			status: 'unavailable',
			message: "That song isn't in our library. Try another request."
		});

		expect(feedbackForAiDjAction(createAction({ status: 'ignored_not_song', decision: 'not_song_request' }))).toEqual({
			status: 'complete',
			message: ''
		});
		expect(feedbackForAiDjAction(createAction({ status: 'analyzing' }))).toEqual({
			status: 'pending',
			message: ''
		});
		expect(feedbackForAiDjAction(null)).toEqual({
			status: 'complete',
			message: ''
		});
	});

	it('returns truthful private confirmations for queued and currently playing requests', () => {
		expect(
			feedbackForAiDjAction(
				createAction({
					status: 'queued_next',
					matchedTrackTitle: 'Neon Rain',
					matchedTrackArtist: 'Adi',
					queuePosition: 1
				})
			)
		).toEqual({
			status: 'accepted',
			message: 'Your request is up next: Adi — Neon Rain.'
		});

		expect(
			feedbackForAiDjAction(
				createAction({
					status: 'queued',
					matchedTrackTitle: 'Static Bloom',
					matchedTrackArtist: 'Saru',
					queuePosition: 3
				})
			)
		).toEqual({
			status: 'accepted',
			message: 'Your request was added to the queue: Saru — Static Bloom.'
		});

		expect(
			feedbackForAiDjAction(
				createAction({
					status: 'already_playing',
					matchedTrackTitle: 'Current Song',
					matchedTrackArtist: 'Test Artist'
				})
			)
		).toEqual({
			status: 'accepted',
			message: 'Your request is playing now: Test Artist — Current Song.'
		});
	});
});

function createAction(patch: Partial<AiDjAction>): AiDjAction {
	return {
		id: 'action-1',
		requestId: 'request-1',
		listenerName: 'Listener',
		requestMessage: 'Play a missing song',
		receivedAt: '2026-07-16T12:00:00.000Z',
		updatedAt: '2026-07-16T12:00:00.000Z',
		status: 'analyzing',
		model: 'gpt-5.6',
		reason: 'Analyzing listener request.',
		...patch
	};
}
