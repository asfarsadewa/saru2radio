import { test, expect, type APIRequestContext } from '@playwright/test';
import { parseBuffer } from 'music-metadata';
import type { PreparationState } from '../../src/lib/types.js';

const STUDIO_URL = `http://127.0.0.1:${process.env.TEST_STUDIO_PORT ?? process.env.STUDIO_PORT ?? 18_011}`;
const PUBLIC_URL = `http://127.0.0.1:${process.env.TEST_PUBLIC_PORT ?? process.env.PUBLIC_PORT ?? 18_012}`;
const ICECAST_URL = `http://127.0.0.1:${process.env.TEST_ICECAST_PORT ?? 18_010}`;

test('AudioWorklet source keeps mixer audio flowing through main-thread jank', async ({ page, request }) => {
	await request.post(`${ICECAST_URL}/__test__/reset`);
	await page.goto(`${STUDIO_URL}/`);
	await expect(page.getByText('1 tracks')).toBeVisible();
	await page.getByLabel('Broadcast mode').selectOption('mixer');
	await page.getByRole('button', { name: 'ON AIR' }).click();
	await expect(page.getByRole('button', { name: 'OFF AIR' })).toBeVisible();

	await expect.poll(async () => (await fakeIcecastStats(request)).totalBytes).toBeGreaterThan(12_000);
	const beforeJank = await fakeIcecastStats(request);
	const jank = await page.evaluate(() => {
		const startedAt = Date.now();
		while (Date.now() - startedAt < 1000) {
			// Deliberately monopolize the DOM/UI thread. Audio capture, encoding,
			// and source transport must continue in the worklet/Worker path.
		}
		return { startedAt, endedAt: Date.now() };
	});

	await expect
		.poll(async () => (await fakeIcecastStats(request)).totalBytes)
		.toBeGreaterThan(beforeJank.totalBytes + 8_000);
	const afterJank = await fakeIcecastStats(request);
	const writesDuringJank = afterJank.chunkTimes.filter(
		(timestamp) => timestamp >= jank.startedAt + 100 && timestamp <= jank.endedAt - 100
	);
	expect(writesDuringJank.length).toBeGreaterThan(0);

	const captureResponse = await request.get(`${ICECAST_URL}/__test__/capture.mp3`);
	const capture = await captureResponse.body();
	const metadata = await parseBuffer(capture, { mimeType: 'audio/mpeg', size: capture.byteLength }, { duration: true });
	expect(metadata.format).toMatchObject({
		container: 'MPEG',
		codec: 'MPEG 2 Layer 3',
		sampleRate: 22_050,
		numberOfChannels: 1,
		bitrate: 128_000
	});
	expect(metadata.format.duration).toBeGreaterThan(1.5);
	await page.getByRole('button', { name: 'OFF AIR' }).click();
	await expect(page.getByRole('button', { name: 'ON AIR' })).toBeVisible();
});

test('AudioWorklet talk break keeps the mic stream flowing through main-thread jank', async ({ page, request }) => {
	await request.post(`${ICECAST_URL}/__test__/reset`);
	await page.goto(`${STUDIO_URL}/`);
	await page.getByRole('button', { name: 'ON AIR' }).click();
	await expect(page.getByRole('button', { name: 'OFF AIR' })).toBeVisible();
	const talkButton = page.getByRole('button', { name: 'Hold talk' });
	await expect(talkButton).toBeEnabled();
	await expect.poll(async () => (await fakeIcecastStats(request)).totalBytes).toBeGreaterThan(12_000);

	await talkButton.hover();
	await page.mouse.down();
	await expect(page.getByRole('button', { name: 'Talking' })).toBeVisible();
	const jank = await page.evaluate(() => {
		const startedAt = Date.now();
		while (Date.now() - startedAt < 1000) {
			// The direct song is paused during this interval. Bytes reaching fake
			// Icecast must therefore be coming from the off-main-thread talk path.
		}
		return { startedAt, endedAt: Date.now() };
	});
	const afterJank = await fakeIcecastStats(request);
	const writesDuringJank = afterJank.chunkTimes.filter(
		(timestamp) => timestamp >= jank.startedAt + 150 && timestamp <= jank.endedAt - 100
	);
	expect(writesDuringJank.length).toBeGreaterThan(0);

	await page.mouse.up();
	await expect(page.getByRole('button', { name: 'Hold talk' })).toBeVisible();
	await page.getByRole('button', { name: 'OFF AIR' }).click();
	await expect(page.getByRole('button', { name: 'ON AIR' })).toBeVisible();
});

test('AudioWorklet source boots the voice program and carries the latched microphone', async ({ page, request }) => {
	await request.post(`${ICECAST_URL}/__test__/reset`);
	await page.goto(`${STUDIO_URL}/`);
	await page.getByRole('button', { name: 'Voice' }).click();
	await page.getByRole('button', { name: 'ON AIR' }).click();
	await expect(page.getByRole('button', { name: 'OFF AIR' })).toBeVisible();
	const micButton = page.getByRole('button', { name: 'Open mic' });
	await expect(micButton).toBeEnabled();
	await micButton.click();
	await expect(page.getByRole('button', { name: 'Mic live' })).toBeVisible();
	await expect.poll(async () => (await fakeIcecastStats(request)).totalBytes).toBeGreaterThan(12_000);
	await page.getByRole('button', { name: 'Mic live' }).click();
	await expect(page.getByRole('button', { name: 'Open mic' })).toBeVisible();
	await page.getByRole('button', { name: 'OFF AIR' }).click();
});

test('studio dashboard renders local booth controls', async ({ page, request }) => {
	await page.goto(`${STUDIO_URL}/`);
	await expect(page.getByRole('heading', { name: 'saru2radio' })).toBeVisible();
	await expect(page.getByRole('button', { name: /(ON|OFF) AIR/i })).toBeVisible();
	await expect(page.getByText('Broadcast library')).toBeVisible();
	await expect(page.getByRole('button', { name: /Prepare/i })).toBeVisible();
	await expect(page.getByText('0 LISTENERS')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Voice' })).toBeVisible();
	await page.getByRole('button', { name: 'Voice' }).click();
	await expect(page.getByText('Ambient bed')).toBeVisible();
	await expect(page.getByText('listener requests', { exact: true })).toBeVisible();
	await expect(page.getByText('AI DJ actions', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: /No mic/i })).toBeDisabled();

	const aiDjActionsResponse = await request.get(`${STUDIO_URL}/api/ai-dj/actions`);
	expect(aiDjActionsResponse.ok()).toBe(true);
	expect(Array.isArray(await aiDjActionsResponse.json())).toBe(true);
	const clearAiDjActionsResponse = await request.delete(`${STUDIO_URL}/api/ai-dj/actions`);
	expect(clearAiDjActionsResponse.ok()).toBe(true);
});

test('Studio rebuilds and syncs the server queue while preserving human Next control', async ({ page }) => {
	const status = {
		onAir: false,
		streamUrl: '',
		stationName: 'saru2radio',
		startedAt: '2026-07-16T12:00:00.000Z',
		icecastUrl: '',
		listenerUrl: '',
		tunnelUrl: null,
		sourceConnected: true,
		activeListeners: 0
	};
	const nowPlaying = {
		trackId: 'current',
		title: 'Current Song',
		artist: 'Test Artist',
		startedAt: '2026-07-16T12:00:00.000Z',
		duration: 180
	};
	const trackIds = ['current', 'middle', 'requested', ...Array.from({ length: 122 }, (_, index) => `extra-${index}`)];
	const tracks = trackIds.map((id, index) => ({
		id,
		sourcePath: `C:\\Music\\${id}.mp3`,
		playPath: `C:\\Music\\.saru2radio-cache\\tracks\\${id}.mp3`,
		fileName: `${id}.mp3`,
		title: index === 0 ? 'Current Song' : index === 1 ? 'Middle Song' : index === 2 ? 'Night Signal' : `Extra Song ${index}`,
		artist: 'Test Artist',
		duration: 180,
		size: 1024,
		mtimeMs: 1,
		cachePath: `C:\\Music\\.saru2radio-cache\\tracks\\${id}.mp3`,
		cacheReady: true,
		cacheStale: false
	}));
	let queuedTrackIds = ['current', 'requested', 'middle', ...trackIds.slice(3)];
	let replacedQueueTrackIds: string[] = [];

	await page.route(`${STUDIO_URL}/api/status`, (route) =>
		route.fulfill({
			json: {
				...status,
				directSongsActive: true,
				queueTrackIds: queuedTrackIds
			}
		})
	);
	await page.route(`${STUDIO_URL}/api/library`, (route) =>
		route.fulfill({
			json: {
				directory: 'C:\\Music',
				tracks,
				preparing: false,
				lastScanAt: '2026-07-16T12:00:00.000Z',
				recursive: false,
				sourceKind: 'cache-manifest'
			}
		})
	);
	await page.route(`${STUDIO_URL}/api/now-playing`, (route) =>
		route.fulfill({ json: nowPlaying })
	);
	await page.route(`${STUDIO_URL}/api/studio-state`, (route) =>
		route.fulfill({
			json: {
				broadcastDirectory: 'C:\\Music',
				broadcastRecursive: false,
				ordered: false,
				prepDirectory: 'C:\\Music',
				updatedAt: '2026-07-16T12:00:00.000Z'
			}
		})
	);
	await page.route(`${STUDIO_URL}/api/broadcast/queue`, async (route) => {
		const body = route.request().postDataJSON() as { trackIds: string[] };
		replacedQueueTrackIds = body.trackIds;
		queuedTrackIds = ['current', 'requested', 'middle', ...trackIds.slice(3)];
		await route.fulfill({
			json: {
				...status,
				directSongsActive: true,
				queueTrackIds: queuedTrackIds
			}
		});
	});
	await page.route(`${STUDIO_URL}/api/broadcast/queue-next`, async (route) => {
		expect(route.request().postDataJSON()).toEqual({ trackId: 'requested' });
		queuedTrackIds = ['current', 'requested', 'middle', ...trackIds.slice(3)];
		await route.fulfill({
			json: {
				...status,
				directSongsActive: true,
				queueTrackIds: queuedTrackIds,
				nowPlaying
			}
		});
	});

	await page.goto(`${STUDIO_URL}/`);

	const trackList = page.getByLabel('Track list');
	await expect(trackList.locator('.track-row')).toHaveCount(125);
	await expect
		.poll(() => trackList.locator('.track-row').first().evaluate((row) => row.getBoundingClientRect().height))
		.toBeGreaterThan(36);
	await expect.poll(() => trackList.evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);

	const trackSearch = page.getByRole('searchbox', { name: 'Search tracks' });
	await trackSearch.fill('night test');
	await expect(trackList.locator('.track-row')).toHaveCount(1);
	await expect(trackList.getByText('Night Signal')).toBeVisible();
	await expect(page.getByText('1 match', { exact: true })).toBeVisible();
	await trackSearch.fill('missing transmission');
	await expect(trackList.locator('.track-row')).toHaveCount(0);
	await expect(trackList.getByText('No tracks match this search.')).toBeVisible();
	await page.getByRole('button', { name: 'Clear track search' }).click();
	await expect(trackList.locator('.track-row')).toHaveCount(125);

	await expect(page.getByRole('button', { name: 'Play Current Song next' })).toBeDisabled();
	await expect(page.locator('.queue-items p').nth(1)).toHaveText('Night Signal');
	const nextButton = page.getByRole('button', { name: 'Play Night Signal next' });
	await expect(nextButton).toBeDisabled();
	await expect(nextButton).toHaveAttribute('title', 'Go on air to queue this song next');

	status.onAir = true;
	await expect(page.getByText('ON AIR', { exact: true })).toBeVisible({ timeout: 5000 });
	await expect(nextButton).toBeEnabled();
	await expect(nextButton).toHaveAttribute('title', 'Play next');

	await page.getByRole('button', { name: 'Shuffle' }).click();
	await expect.poll(() => replacedQueueTrackIds).toEqual(trackIds);
	await expect(page.locator('.queue-items p').nth(1)).toHaveText('Night Signal');

	queuedTrackIds = ['current', 'middle', 'requested', ...trackIds.slice(3)];
	await expect(page.locator('.queue-items p').nth(1)).toHaveText('Middle Song', { timeout: 5000 });

	await expect(nextButton).toBeEnabled();
	await nextButton.click();

	await expect.poll(() => queuedTrackIds.slice(0, 3)).toEqual(['current', 'requested', 'middle']);
	await expect(nextButton).toContainText('Queued');
	await expect(page.locator('.queue-items p').nth(1)).toHaveText('Night Signal');

	nowPlaying.trackId = 'removed-current';
	nowPlaying.title = 'Removed Current Song';
	queuedTrackIds = ['removed-current', 'requested', 'middle', ...trackIds.slice(3)];
	await expect(page.getByRole('button', { name: 'Play Night Signal next' })).toContainText('Queued', {
		timeout: 5000
	});
	await expect(page.getByRole('button', { name: 'Play Middle Song next' })).toBeEnabled();
});

test('Studio ignores stale polls and keeps direct controls when stop fails', async ({ page }) => {
	const offAirStatus = {
		onAir: false,
		streamUrl: '',
		stationName: 'saru2radio',
		startedAt: null,
		icecastUrl: '',
		listenerUrl: '',
		tunnelUrl: null,
		sourceConnected: true,
		activeListeners: 0,
		directSongsActive: false,
		queueTrackIds: []
	};
	const liveStatus = {
		...offAirStatus,
		onAir: true,
		startedAt: '2026-07-19T03:00:00.000Z',
		directSongsActive: true,
		queueTrackIds: ['track-1']
	};
	const nowPlaying = {
		trackId: 'track-1',
		title: 'Current Song',
		artist: 'Test Artist',
		startedAt: '2026-07-19T03:00:00.000Z',
		duration: 180
	};
	let live = false;
	let statusRequestCount = 0;
	let skipRequests = 0;
	let releaseStalePoll!: () => void;
	let markStalePollStarted!: () => void;
	let markStalePollDelivered!: () => void;
	const stalePollRelease = new Promise<void>((resolve) => {
		releaseStalePoll = resolve;
	});
	const stalePollStarted = new Promise<void>((resolve) => {
		markStalePollStarted = resolve;
	});
	const stalePollDelivered = new Promise<void>((resolve) => {
		markStalePollDelivered = resolve;
	});

	await page.route(`${STUDIO_URL}/api/status`, async (route) => {
		statusRequestCount += 1;
		if (statusRequestCount === 2) {
			markStalePollStarted();
			await stalePollRelease;
			await route.fulfill({ json: offAirStatus });
			markStalePollDelivered();
			return;
		}
		await route.fulfill({ json: live ? liveStatus : offAirStatus });
	});
	await page.route(`${STUDIO_URL}/api/library`, (route) =>
		route.fulfill({
			json: {
				directory: 'C:\\Music',
				tracks: [
					{
						id: 'track-1',
						sourcePath: 'C:\\Music\\track-1.mp3',
						playPath: 'C:\\Music\\.saru2radio-cache\\tracks\\track-1.mp3',
						fileName: 'track-1.mp3',
						title: 'Current Song',
						artist: 'Test Artist',
						duration: 180,
						size: 1024,
						mtimeMs: 1,
						cachePath: 'C:\\Music\\.saru2radio-cache\\tracks\\track-1.mp3',
						cacheReady: true,
						cacheStale: false
					}
				],
				preparing: false,
				lastScanAt: '2026-07-19T03:00:00.000Z',
				recursive: false,
				sourceKind: 'cache-manifest'
			}
		})
	);
	await page.route(`${STUDIO_URL}/api/now-playing`, (route) => route.fulfill({ json: nowPlaying }));
	await page.route(`${STUDIO_URL}/api/broadcast/start`, async (route) => {
		live = true;
		await route.fulfill({ json: liveStatus });
	});
	await page.route(`${STUDIO_URL}/api/broadcast/stop`, (route) =>
		route.fulfill({ status: 503, contentType: 'text/plain', body: 'Simulated stop failure.' })
	);
	await page.route(`${STUDIO_URL}/api/broadcast/skip`, async (route) => {
		skipRequests += 1;
		await route.fulfill({ json: liveStatus });
	});

	await page.goto(`${STUDIO_URL}/`);
	await stalePollStarted;
	await page.getByRole('button', { name: 'ON AIR' }).click();
	await expect(page.getByRole('button', { name: 'OFF AIR' })).toBeVisible();

	releaseStalePoll();
	await stalePollDelivered;
	await expect(page.getByRole('button', { name: 'OFF AIR' })).toBeVisible();

	await page.getByRole('button', { name: 'OFF AIR' }).click();
	await expect(page.getByText('Simulated stop failure.')).toBeVisible();
	await page.getByRole('button', { name: 'Skip track' }).click();
	await expect.poll(() => skipRequests).toBe(1);
});

test('Studio prepares new tracks on air and merges them into the live queue', async ({ page }) => {
	const directory = 'C:\\Music';
	const startedAt = '2026-07-18T12:00:00.000Z';
	const status = {
		onAir: true,
		streamUrl: '',
		stationName: 'saru2radio',
		startedAt,
		icecastUrl: '',
		listenerUrl: '',
		tunnelUrl: null,
		sourceConnected: true,
		activeListeners: 0,
		directSongsActive: true,
		queueTrackIds: ['current', 'requested', 'existing']
	};
	const makeTrack = (id: string, title: string) => ({
		id,
		sourcePath: `${directory}\\${id}.mp3`,
		playPath: `${directory}\\.saru2radio-cache\\tracks\\${id}.mp3`,
		fileName: `${id}.mp3`,
		title,
		artist: 'Test Artist',
		duration: 180,
		size: 1024,
		mtimeMs: 1,
		cachePath: `${directory}\\.saru2radio-cache\\tracks\\${id}.mp3`,
		cacheReady: true,
		cacheStale: false
	});
	const initialTracks = [
		makeTrack('current', 'Current Song'),
		makeTrack('requested', 'Listener Request'),
		makeTrack('existing', 'Existing Song')
	];
	const newTrack = makeTrack('new-track', 'Newly Prepared Song');
	const readyPreparation: PreparationState = {
		phase: 'ready',
		scope: 'all',
		directory,
		recursive: false,
		toolAvailable: true,
		total: 4,
		targetTotal: 0,
		ready: 2,
		pending: 2,
		stale: 1,
		deferred: 0,
		completed: 0,
		converted: 0,
		skipped: 0,
		failed: 0,
		currentTrack: null,
		failures: [],
		startedAt: null,
		finishedAt: null,
		updatedAt: startedAt,
		error: null
	};
	let preparation: PreparationState = readyPreparation;
	let startBody: { directory: string; recursive: boolean } | null = null;
	let rescanned = false;
	let replacementQueue: string[] = [];

	await page.route(`${STUDIO_URL}/api/config`, (route) =>
		route.fulfill({
			json: {
				stationName: 'saru2radio',
				studioUrl: STUDIO_URL,
				listenerUrl: '',
				icecastUrl: '',
				mount: '/live.mp3',
				bitrateKbps: 128,
				radioToolPath: 'C:\\Tools\\make-radio-sound.exe',
				cloudflaredAvailable: false,
				aiDj: {
					enabled: true,
					configured: true,
					model: 'gpt-5.6',
					minConfidence: 0.72,
					status: 'ready'
				}
			}
		})
	);
	await page.route(`${STUDIO_URL}/api/status`, (route) => route.fulfill({ json: status }));
	await page.route(`${STUDIO_URL}/api/now-playing`, (route) =>
		route.fulfill({
			json: {
				trackId: 'current',
				title: 'Current Song',
				artist: 'Test Artist',
				startedAt,
				duration: 180
			}
		})
	);
	await page.route(`${STUDIO_URL}/api/studio-state`, (route) =>
		route.fulfill({
			json: {
				broadcastDirectory: directory,
				broadcastRecursive: false,
				ordered: true,
				prepDirectory: directory,
				updatedAt: startedAt
			}
		})
	);
	await page.route(`${STUDIO_URL}/api/library`, (route) =>
		route.fulfill({
			json: {
				directory,
				tracks: initialTracks,
				preparing: false,
				lastScanAt: startedAt,
				recursive: false,
				sourceKind: 'cache-manifest'
			}
		})
	);
	await page.route(`${STUDIO_URL}/api/library/scan`, (route) => {
		rescanned = true;
		return route.fulfill({
			json: {
				directory,
				tracks: [...initialTracks, newTrack],
				preparing: false,
				lastScanAt: startedAt,
				recursive: false,
				sourceKind: 'cache-manifest'
			}
		});
	});
	await page.route(`${STUDIO_URL}/api/preparation`, (route) => route.fulfill({ json: preparation }));
	await page.route(`${STUDIO_URL}/api/preparation/start`, async (route) => {
		startBody = route.request().postDataJSON() as { directory: string; recursive: boolean };
		preparation = {
			...readyPreparation,
			phase: 'completed',
			scope: 'missing-only',
			targetTotal: 1,
			ready: 3,
			pending: 1,
			stale: 1,
			deferred: 1,
			completed: 1,
			converted: 1,
			startedAt,
			finishedAt: '2026-07-18T12:01:00.000Z'
		};
		await route.fulfill({
			status: 202,
			json: {
				...readyPreparation,
				phase: 'scanning',
				scope: 'missing-only',
				startedAt
			}
		});
	});
	await page.route(`${STUDIO_URL}/api/broadcast/queue`, async (route) => {
		replacementQueue = (route.request().postDataJSON() as { trackIds: string[] }).trackIds;
		await route.fulfill({
			json: {
				...status,
				queueTrackIds: ['current', 'requested', 'existing', 'new-track']
			}
		});
	});

	await page.goto(`${STUDIO_URL}/`);
	const prepareButton = page.getByRole('button', { name: 'Prepare 1' });
	await expect(prepareButton).toBeEnabled();
	await prepareButton.click();

	await expect.poll(() => startBody).toEqual({ directory, recursive: false });
	await expect.poll(() => rescanned).toBe(true);
	await expect.poll(() => replacementQueue).toEqual(expect.arrayContaining(['new-track']));
	await expect(page.getByText('4 tracks')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Stale deferred', exact: true })).toBeDisabled();
	await expect(page.getByText('1 stale left for an off-air pass', { exact: false })).toBeVisible();
	await expect(page.locator('.queue-items p').nth(1)).toHaveText('Listener Request');
});

test('public facade renders listener page and hides studio API', async ({ page, request }) => {
	await page.goto(`${PUBLIC_URL}/`);
	await expect(page.getByRole('heading', { name: 'saru2radio' })).toBeVisible();
	await expect(page.getByText('request line')).toBeVisible();

	const apiResponse = await request.get(`${PUBLIC_URL}/api/config`);
	expect(apiResponse.status()).toBe(404);
	const messagesResponse = await request.get(`${PUBLIC_URL}/api/listener-messages`);
	expect(messagesResponse.status()).toBe(404);
	const aiDjActionsResponse = await request.get(`${PUBLIC_URL}/api/ai-dj/actions`);
	expect(aiDjActionsResponse.status()).toBe(404);

	const statusResponse = await request.get(`${PUBLIC_URL}/status.json`);
	expect(statusResponse.ok()).toBe(true);
	const status = await statusResponse.json();
	expect(status.activeListeners).toBe(0);
	const playButton = page.getByRole('button', { name: 'Play stream' });
	const sendButton = page.getByRole('button', { name: /send/i });
	if (status.onAir) {
		await expect(playButton).toBeEnabled();
		await expect(sendButton).toBeEnabled();
		await expect(page.getByLabel('Song request or message')).toBeEnabled();
	} else {
		await expect(playButton).toBeDisabled();
		await expect(sendButton).toBeDisabled();
		await expect(page.getByLabel('Song request or message')).toBeDisabled();
	}
	expect(status.icecastUrl).toBe('');
});

test('listener status polling does not clear a playback failure', async ({ page }) => {
	const status = {
		onAir: true,
		streamUrl: `${PUBLIC_URL}/live.mp3`,
		stationName: 'saru2radio',
		startedAt: '2026-07-19T03:00:00.000Z',
		icecastUrl: '',
		listenerUrl: PUBLIC_URL,
		tunnelUrl: null,
		sourceConnected: true,
		activeListeners: 1
	};
	await page.addInitScript(() => {
		HTMLMediaElement.prototype.play = () => Promise.reject(new Error('Simulated playback failure'));
	});
	await page.route(`${PUBLIC_URL}/status.json`, (route) => route.fulfill({ json: status }));
	await page.route(`${PUBLIC_URL}/now-playing.json`, (route) =>
		route.fulfill({
			json: {
				trackId: 'current',
				title: 'Current Song',
				artist: 'Test Artist',
				startedAt: '2026-07-19T03:00:00.000Z',
				duration: 180
			}
		})
	);

	await page.goto(`${PUBLIC_URL}/`);
	await page.getByRole('button', { name: 'Play stream' }).click();
	await expect(page.getByText('The live stream is not ready yet.')).toBeVisible();
	await page.waitForTimeout(3_750);
	await expect(page.getByText('The live stream is not ready yet.')).toBeVisible();
});

test('listener receives private AI DJ replies and can request again', async ({ page }) => {
	const status = {
		onAir: true,
		streamUrl: `${PUBLIC_URL}/live.mp3`,
		stationName: 'saru2radio',
		startedAt: '2026-07-16T12:00:00.000Z',
		icecastUrl: '',
		listenerUrl: PUBLIC_URL,
		tunnelUrl: null,
		sourceConnected: true,
		activeListeners: 1
	};
	let submittedRequests = 0;
	let feedbackChecks = 0;

	await page.route(`${PUBLIC_URL}/status.json`, (route) => route.fulfill({ json: status }));
	await page.route(`${PUBLIC_URL}/now-playing.json`, (route) =>
		route.fulfill({
			json: {
				trackId: 'current',
				title: 'Current Song',
				artist: 'Test Artist',
				startedAt: '2026-07-16T12:00:00.000Z',
				duration: 180
			}
		})
	);
	await page.route(`${PUBLIC_URL}/requests`, async (route) => {
		submittedRequests += 1;
		const requestId = `request-${submittedRequests}`;
		await route.fulfill({
			status: 201,
			json: {
				id: requestId,
				name: 'Listener',
				message: submittedRequests === 1 ? 'Play Missing Song' : 'Play Another Song',
				receivedAt: '2026-07-16T12:00:00.000Z',
				feedbackToken: `token-${submittedRequests}`
			}
		});
	});
	await page.route(`${PUBLIC_URL}/requests/request-1/feedback`, async (route) => {
		expect(route.request().headers()['x-saru2radio-request-token']).toBe('token-1');
		feedbackChecks += 1;
		await route.fulfill({
			json:
				feedbackChecks === 1
					? { status: 'pending', message: '' }
					: { status: 'unavailable', message: "That song isn't in our library. Try another request." }
		});
	});
	await page.route(`${PUBLIC_URL}/requests/request-2/feedback`, (route) =>
		route.fulfill({
			json: {
				status: 'accepted',
				message: 'Your request is up next: Test Artist — Another Song.'
			}
		})
	);

	await page.goto(`${PUBLIC_URL}/`);
	await page.getByLabel('Your name').fill('Listener');
	await page.getByLabel('Song request or message').fill('Play Missing Song');
	await page.getByRole('button', { name: 'Send' }).click();

	await expect(page.getByLabel('Song request or message')).toBeEnabled();
	await expect(page.getByRole('status')).toContainText("That song isn't in our library. Try another request.");

	await page.getByLabel('Song request or message').fill('Play Another Song');
	await page.getByRole('button', { name: 'Send' }).click();
	await expect.poll(() => submittedRequests).toBe(2);
	await expect(page.getByRole('status')).toContainText(
		'Your request is up next: Test Artist — Another Song.'
	);
});

type FakeIcecastStats = {
	totalBytes: number;
	chunkTimes: number[];
	chunkSizes: number[];
	sourceRequests: number;
};

async function fakeIcecastStats(request: APIRequestContext): Promise<FakeIcecastStats> {
	const response = await request.get(`${ICECAST_URL}/__test__/stats`);
	expect(response.ok()).toBe(true);
	return response.json() as Promise<FakeIcecastStats>;
}
