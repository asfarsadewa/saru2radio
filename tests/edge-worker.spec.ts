import { describe, expect, it, vi } from 'vitest';
import worker, { isAllowedPublicPath, offlineResponse, toOriginUrl } from '../cloudflare/saru2radio-listener-edge.js';

describe('saru2radio listener edge Worker', () => {
	it('routes public requests to the hidden tunnel origin', () => {
		const url = toOriginUrl(new URL('https://saru2radio.com/status.json?x=1'));

		expect(url.toString()).toBe('https://origin.saru2radio.com/status.json?x=1');
	});

	it('serves listener-safe offline responses', async () => {
		const status = await offlineResponse(new URL('https://saru2radio.com/status.json')).json();
		const nowPlaying = await offlineResponse(new URL('https://saru2radio.com/now-playing.json')).json();
		const stream = await offlineResponse(new URL('https://saru2radio.com/live.mp3')).text();

		expect(status).toMatchObject({
			onAir: false,
			icecastUrl: '',
			listenerUrl: 'https://saru2radio.com',
			activeListeners: 0
		});
		expect(nowPlaying).toMatchObject({ title: 'Off air', artist: 'saru2radio' });
		expect(stream).toContain('offline');
		expect(offlineResponse(new URL('https://saru2radio.com/live.mp3')).status).toBe(503);
	});

	it('falls back when the tunnel returns Cloudflare 1033 status', async () => {
		const fetchMock = vi.fn(async () => new Response('error code: 1033', { status: 530 }));
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(new Request('https://saru2radio.com/status.json'));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ onAir: false });
		expect(fetchMock).toHaveBeenCalledOnce();
		vi.unstubAllGlobals();
	});

	it('passes through healthy origin responses', async () => {
		const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(new Request('https://saru2radio.com/'));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
		vi.unstubAllGlobals();
	});

	it('marks live MP3 responses as non-transforming streams', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response('mp3', {
					status: 200,
					headers: { 'content-type': 'audio/mpeg' }
				})
		);
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(new Request('https://saru2radio.com/live.mp3'));

		expect(response.headers.get('content-type')).toBe('audio/mpeg');
		expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
		expect(await response.text()).toBe('mp3');
		vi.unstubAllGlobals();
	});

	it('rewrites healthy status responses to the public listener URL', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						onAir: true,
						streamUrl: 'https://origin.saru2radio.com/live.mp3',
						icecastUrl: 'http://127.0.0.1:8010/live.mp3',
						listenerUrl: 'https://origin.saru2radio.com',
						tunnelUrl: 'https://origin.saru2radio.com',
						sourceConnected: true,
						activeListeners: 3
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' }
					}
				)
		);
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(new Request('https://saru2radio.com/status.json'));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			onAir: true,
			streamUrl: 'https://saru2radio.com/live.mp3',
			icecastUrl: '',
			listenerUrl: 'https://saru2radio.com',
			tunnelUrl: 'https://saru2radio.com',
			activeListeners: 3
		});
		vi.unstubAllGlobals();
	});

	it('refuses to proxy paths outside the listener surface', async () => {
		const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		for (const path of ['/api/config', '/api/listener-messages', '/api/monitor/live.mp3', '/studio.html']) {
			const response = await worker.fetch(new Request(`https://saru2radio.com${path}`));
			expect(response.status).toBe(404);
		}
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('allows request-line paths and asset paths through the allowlist', () => {
		expect(isAllowedPublicPath('/requests')).toBe(true);
		expect(isAllowedPublicPath('/requests/abc123/feedback')).toBe(true);
		expect(isAllowedPublicPath('/assets/listener-abc123.js')).toBe(true);
		expect(isAllowedPublicPath('/status.json')).toBe(true);
		expect(isAllowedPublicPath('/api/status')).toBe(false);
		expect(isAllowedPublicPath('/requestsx')).toBe(false);
	});

	it('replaces client-supplied forwarded headers with the sanitized visitor IP', async () => {
		const fetchMock = vi.fn(async (_input: unknown) => new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await worker.fetch(
			new Request('https://saru2radio.com/', {
				headers: {
					'cf-connecting-ip': '203.0.113.7',
					'x-forwarded-for': '198.51.100.1, 192.0.2.1'
				}
			})
		);

		const originRequest = fetchMock.mock.calls[0]?.[0] as Request;
		expect(originRequest.headers.get('x-forwarded-for')).toBe('203.0.113.7');
		vi.unstubAllGlobals();
	});
});
