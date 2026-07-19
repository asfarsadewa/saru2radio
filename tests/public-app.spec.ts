import express from 'express';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiDjActionStore } from '../server/ai-dj.js';
import { ListenerFeedbackStore } from '../server/listener-feedback.js';
import { ListenerMessageStore } from '../server/listener-messages.js';
import { createPublicApp } from '../server/public-app.js';
import { createStudioHostGuard, createStudioOriginGuard } from '../server/security.js';
import type { AiDjAction, BroadcastStatus, ListenerMessage, NowPlaying } from '../src/lib/types.js';

let distDir: string;

beforeAll(async () => {
	distDir = await fs.mkdtemp(path.join(tmpdir(), 'saru2radio-public-app-'));
	await fs.writeFile(path.join(distDir, 'listener.html'), '<!doctype html><title>saru2radio test listener</title>\n');
});

afterAll(async () => {
	await fs.rm(distDir, { recursive: true, force: true });
});

describe('public listener facade routes', () => {
	it('serves the listener page and keeps the studio API hidden', async () => {
		const rig = await makeRig();
		try {
			const page = await fetch(`${rig.baseUrl}/`);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain('saru2radio test listener');

			expect((await fetch(`${rig.baseUrl}/api/config`)).status).toBe(404);
			expect((await fetch(`${rig.baseUrl}/api/listener-messages`)).status).toBe(404);
		} finally {
			await rig.close();
		}
	});

	it('projects status and now-playing for listeners', async () => {
		const rig = await makeRig();
		try {
			const status = (await (await fetch(`${rig.baseUrl}/status.json`)).json()) as BroadcastStatus;
			expect(status).toMatchObject({ onAir: true, stationName: 'saru2radio', icecastUrl: '' });

			const nowPlaying = (await (await fetch(`${rig.baseUrl}/now-playing.json`)).json()) as NowPlaying;
			expect(nowPlaying).toMatchObject({ title: 'Off air' });

			// The stream route is wired to the proxy handler, not the 404 fallback.
			expect((await fetch(`${rig.baseUrl}/live.mp3`)).status).toBe(503);
		} finally {
			await rig.close();
		}
	});

	it('rejects requests while off air without spending an AI call', async () => {
		const rig = await makeRig({ onAir: false });
		try {
			const response = await postRequest(rig.baseUrl, { name: 'Adi', message: 'Neon Rain please' });
			expect(response.status).toBe(409);
			expect(rig.listenerMessages.list()).toHaveLength(0);
			expect(rig.enqueued).toHaveLength(0);
		} finally {
			await rig.close();
		}
	});

	it('rejects invalid input with 400 and stores nothing', async () => {
		const rig = await makeRig();
		try {
			const response = await postRequest(rig.baseUrl, { name: '', message: '' });
			expect(response.status).toBe(400);
			expect(await response.text()).toContain('Name is required.');
			expect(rig.listenerMessages.list()).toHaveLength(0);
			expect(rig.enqueued).toHaveLength(0);
		} finally {
			await rig.close();
		}
	});

	it('accepts a request with a feedback token and enqueues the AI DJ', async () => {
		const rig = await makeRig();
		try {
			const response = await postRequest(rig.baseUrl, { name: 'Adi', message: 'Neon Rain please' });
			expect(response.status).toBe(201);
			const body = (await response.json()) as ListenerMessage & { feedbackToken: string };
			expect(body).toMatchObject({ name: 'Adi', message: 'Neon Rain please' });
			expect(body.feedbackToken.length).toBeGreaterThan(0);
			expect(rig.listenerMessages.list()).toHaveLength(1);
			expect(rig.enqueued).toHaveLength(1);
		} finally {
			await rig.close();
		}
	});

	it('answers feedback only to the submitting listener token', async () => {
		const rig = await makeRig();
		try {
			const created = await postRequest(rig.baseUrl, { name: 'Adi', message: 'Neon Rain please' });
			const receipt = (await created.json()) as ListenerMessage & { feedbackToken: string };

			expect((await fetch(`${rig.baseUrl}/requests/${receipt.id}/feedback`)).status).toBe(404);
			expect(
				(
					await fetch(`${rig.baseUrl}/requests/${receipt.id}/feedback`, {
						headers: { 'x-saru2radio-request-token': 'wrong-token' }
					})
				).status
			).toBe(404);

			const feedback = await fetch(`${rig.baseUrl}/requests/${receipt.id}/feedback`, {
				headers: { 'x-saru2radio-request-token': receipt.feedbackToken }
			});
			expect(feedback.status).toBe(200);
			expect(await feedback.json()).toEqual({ status: 'pending', message: '' });
		} finally {
			await rig.close();
		}
	});

	it('rate limits per client while other clients stay served', async () => {
		const rig = await makeRig({ limit: 2 });
		try {
			expect((await postRequest(rig.baseUrl, validBody())).status).toBe(201);
			expect((await postRequest(rig.baseUrl, validBody())).status).toBe(201);
			const blocked = await postRequest(rig.baseUrl, validBody());
			expect(blocked.status).toBe(429);
			expect(blocked.headers.get('retry-after')).not.toBeNull();

			expect((await postRequest(rig.baseUrl, validBody(), '203.0.113.99')).status).toBe(201);
		} finally {
			await rig.close();
		}
	});

	it('caps requests station-wide even when client keys differ', async () => {
		const rig = await makeRig({ limit: 10, globalLimit: 1 });
		try {
			expect((await postRequest(rig.baseUrl, validBody(), '203.0.113.1')).status).toBe(201);
			expect((await postRequest(rig.baseUrl, validBody(), '203.0.113.2')).status).toBe(429);
		} finally {
			await rig.close();
		}
	});

	it('does not spend the station-wide bucket on invalid input', async () => {
		const rig = await makeRig({ limit: 10, globalLimit: 1 });
		try {
			expect((await postRequest(rig.baseUrl, { name: '', message: '' })).status).toBe(400);
			expect((await postRequest(rig.baseUrl, validBody())).status).toBe(201);
		} finally {
			await rig.close();
		}
	});
});

describe('studio guard middleware', () => {
	it('rejects foreign Host headers and allows loopback studio hosts', async () => {
		const app = express();
		app.use(createStudioHostGuard(8011));
		app.get('/api/config', (_request, response) => response.json({ ok: true }));
		const { port, close } = await listen(app);
		try {
			expect((await rawRequest(port, { headers: { host: 'evil.example.com:8011' } })).status).toBe(403);
			expect((await rawRequest(port, { headers: { host: '127.0.0.1.evil.example.com:8011' } })).status).toBe(403);
			expect((await rawRequest(port, { headers: { host: '127.0.0.1:8011' } })).status).toBe(200);
			expect((await rawRequest(port, { headers: { host: 'localhost:8011' } })).status).toBe(200);
		} finally {
			await close();
		}
	});

	it('rejects cross-site writes and allows same-origin and non-browser writes', async () => {
		const app = express();
		app.use('/api', createStudioOriginGuard(8011));
		app.post('/api/do', (_request, response) => response.json({ ok: true }));
		const { port, close } = await listen(app);
		try {
			expect(
				(await rawRequest(port, { method: 'POST', path: '/api/do', headers: { origin: 'https://evil.example.com' } })).status
			).toBe(403);
			expect(
				(await rawRequest(port, { method: 'POST', path: '/api/do', headers: { origin: 'http://127.0.0.1:8011' } })).status
			).toBe(200);
			// Non-browser local tools omit Origin entirely.
			expect((await rawRequest(port, { method: 'POST', path: '/api/do' })).status).toBe(200);
		} finally {
			await close();
		}
	});
});

type TestRig = {
	baseUrl: string;
	enqueued: ListenerMessage[];
	listenerMessages: ListenerMessageStore;
	close(): Promise<void>;
};

async function makeRig(options: { onAir?: boolean; limit?: number; globalLimit?: number } = {}): Promise<TestRig> {
	const onAir = options.onAir ?? true;
	const listenerMessages = new ListenerMessageStore();
	const listenerFeedback = new ListenerFeedbackStore();
	const aiDjActions = new AiDjActionStore();
	const enqueued: ListenerMessage[] = [];
	const status: BroadcastStatus = {
		onAir,
		streamUrl: 'http://127.0.0.1/live.mp3',
		stationName: 'saru2radio',
		startedAt: null,
		icecastUrl: '',
		listenerUrl: 'http://127.0.0.1',
		tunnelUrl: null,
		sourceConnected: false,
		activeListeners: 0
	};
	const nowPlaying: NowPlaying = {
		trackId: null,
		title: 'Off air',
		artist: 'saru2radio',
		startedAt: null,
		duration: null
	};

	const app = createPublicApp({
		distDir,
		listenerRequestLimit: options.limit ?? 6,
		listenerRequestGlobalLimit: options.globalLimit ?? 30,
		listenerRequestWindowMs: 60_000,
		getStatus: () => status,
		getNowPlaying: () => nowPlaying,
		getPublicStatus: () => ({ ...status, icecastUrl: '' }),
		listenerMessages,
		listenerFeedback,
		aiDj: {
			enqueue: (message: ListenerMessage): AiDjAction => {
				enqueued.push(message);
				return aiDjActions.start(message, 'test-model');
			}
		},
		aiDjActions,
		proxyLiveStream: (_request, response) => {
			response.status(503).type('text/plain').send('saru2radio is off air.');
		}
	});

	const { port, close } = await listen(app);
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		enqueued,
		listenerMessages,
		close
	};
}

async function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
	const server = await new Promise<http.Server>((resolve) => {
		const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
	});
	const { port } = server.address() as AddressInfo;
	return {
		port,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			})
	};
}

function postRequest(baseUrl: string, body: unknown, ip = '203.0.113.10'): Promise<Response> {
	return fetch(`${baseUrl}/requests`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
		body: JSON.stringify(body)
	});
}

function validBody(): { name: string; message: string } {
	return { name: 'Adi', message: 'Neon Rain please' };
}

function rawRequest(
	port: number,
	options: { method?: string; path?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = http.request(
			{
				host: '127.0.0.1',
				port,
				method: options.method ?? 'GET',
				path: options.path ?? '/api/config',
				headers: options.headers ?? {}
			},
			(response) => {
				let body = '';
				response.on('data', (chunk) => (body += chunk));
				response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
			}
		);
		request.on('error', reject);
		request.end();
	});
}
