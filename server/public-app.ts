import express from 'express';
import path from 'node:path';
import type { BroadcastStatus, NowPlaying } from '../src/lib/types.js';
import type { AiDjActionStore, AiDjRequestAgent } from './ai-dj.js';
import { feedbackForAiDjAction, type ListenerFeedbackStore } from './listener-feedback.js';
import {
	ListenerMessageValidationError,
	validateListenerMessageInput,
	type ListenerMessageStore,
	type ValidatedListenerMessageInput
} from './listener-messages.js';
import { createRateLimitMiddleware, FixedWindowRateLimiter, listenerRequestKey } from './security.js';

export type PublicAppOptions = {
	distDir: string;
	listenerRequestLimit: number;
	listenerRequestGlobalLimit: number;
	listenerRequestWindowMs: number;
	getStatus: () => BroadcastStatus;
	getNowPlaying: () => NowPlaying;
	getPublicStatus: (request: express.Request) => BroadcastStatus;
	listenerMessages: ListenerMessageStore;
	listenerFeedback: ListenerFeedbackStore;
	aiDj: Pick<AiDjRequestAgent, 'enqueue'>;
	aiDjActions: Pick<AiDjActionStore, 'findByRequestId'>;
	proxyLiveStream: express.RequestHandler;
};

// The public listener facade. Kept separate from index.ts so the whole
// internet-facing surface (request line, feedback receipts, stream proxy) can
// be route-tested without booting the studio server or Icecast.
export function createPublicApp(options: PublicAppOptions) {
	const app = express();
	const listenerRequestLimiter = new FixedWindowRateLimiter({
		limit: options.listenerRequestLimit,
		windowMs: options.listenerRequestWindowMs
	});
	// Per-client keys are spoofable via forwarded headers, so a station-wide
	// bucket caps total accepted requests (and therefore paid AI DJ calls).
	const listenerRequestGlobalLimiter = new FixedWindowRateLimiter({
		limit: options.listenerRequestGlobalLimit,
		windowMs: options.listenerRequestWindowMs
	});
	app.disable('x-powered-by');
	app.use('/assets', express.static(path.join(options.distDir, 'assets'), { immutable: true, maxAge: '1h' }));

	app.get('/', (_request, response) => response.sendFile(path.join(options.distDir, 'listener.html')));
	app.get('/status.json', (request, response) => response.json(options.getPublicStatus(request)));
	app.get('/now-playing.json', (_request, response) => response.json(options.getNowPlaying()));
	app.post(
		'/requests',
		createRateLimitMiddleware(listenerRequestLimiter, listenerRequestKey),
		express.json({ limit: '8kb' }),
		(request, response, next) => {
			if (!options.getStatus().onAir) {
				response.status(409).type('text/plain').send('The station is off air.');
				return;
			}

			try {
				response.locals.listenerMessageInput = validateListenerMessageInput(request.body ?? {});
				next();
			} catch (error) {
				if (error instanceof ListenerMessageValidationError) {
					response.status(400).type('text/plain').send(error.message);
					return;
				}
				next(error);
			}
		},
		createRateLimitMiddleware(listenerRequestGlobalLimiter, () => 'global'),
		(request, response) => {
			try {
				const listenerMessage = options.listenerMessages.create(
					response.locals.listenerMessageInput as ValidatedListenerMessageInput
				);
				const feedbackToken = options.listenerFeedback.issue(listenerMessage.id);
				try {
					options.aiDj.enqueue(listenerMessage);
				} catch (error) {
					console.error(`[ai-dj] ${error instanceof Error ? error.message : error}`);
				}
				response.set('cache-control', 'no-store');
				response.status(201).json({ ...listenerMessage, feedbackToken });
			} catch (error) {
				if (error instanceof ListenerMessageValidationError) {
					response.status(400).type('text/plain').send(error.message);
					return;
				}
				throw error;
			}
		}
	);
	app.get('/requests/:id/feedback', (request, response) => {
		const token = request.get('x-saru2radio-request-token') ?? '';
		if (!options.listenerFeedback.authorize(request.params.id, token)) {
			response.status(404).type('text/plain').send('Not found');
			return;
		}

		response.set('cache-control', 'no-store');
		response.json(feedbackForAiDjAction(options.aiDjActions.findByRequestId(request.params.id)));
	});
	app.get('/live.mp3', options.proxyLiveStream);
	app.use((_request, response) => response.status(404).type('text/plain').send('Not found'));
	return app;
}
