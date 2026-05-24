import { describe, expect, it, vi } from 'vitest';
import worker, { offlineResponse, toOriginUrl } from '../cloudflare/saru2radio-listener-edge.js';

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
			listenerUrl: 'https://saru2radio.com'
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
						sourceConnected: true
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
			tunnelUrl: 'https://saru2radio.com'
		});
		vi.unstubAllGlobals();
	});
});
