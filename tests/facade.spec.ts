import { test, expect } from '@playwright/test';

const STUDIO_URL = `http://127.0.0.1:${process.env.TEST_STUDIO_PORT ?? process.env.STUDIO_PORT ?? 18_011}`;
const PUBLIC_URL = `http://127.0.0.1:${process.env.TEST_PUBLIC_PORT ?? process.env.PUBLIC_PORT ?? 18_012}`;

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

test('human DJ can queue a ready song directly after the current song', async ({ page }) => {
	const status = {
		onAir: true,
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
	const tracks = ['current', 'middle', 'requested'].map((id, index) => ({
		id,
		sourcePath: `C:\\Music\\${id}.mp3`,
		playPath: `C:\\Music\\.saru2radio-cache\\tracks\\${id}.mp3`,
		fileName: `${id}.mp3`,
		title: index === 0 ? 'Current Song' : index === 1 ? 'Middle Song' : 'Night Signal',
		artist: 'Test Artist',
		duration: 180,
		size: 1024,
		mtimeMs: 1,
		cachePath: `C:\\Music\\.saru2radio-cache\\tracks\\${id}.mp3`,
		cacheReady: true,
		cacheStale: false
	}));
	let queuedTrackIds: string[] = [];

	await page.route(`${STUDIO_URL}/api/status`, (route) => route.fulfill({ json: status }));
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
				ordered: true,
				prepDirectory: 'C:\\Music',
				updatedAt: '2026-07-16T12:00:00.000Z'
			}
		})
	);
	await page.route(`${STUDIO_URL}/api/broadcast/queue-next`, async (route) => {
		expect(route.request().postDataJSON()).toEqual({ trackId: 'requested' });
		queuedTrackIds = ['current', 'requested', 'middle'];
		await route.fulfill({ json: { ...status, queueTrackIds: queuedTrackIds, nowPlaying } });
	});

	await page.goto(`${STUDIO_URL}/`);

	await expect(page.getByRole('button', { name: 'Play Current Song next' })).toBeDisabled();
	const nextButton = page.getByRole('button', { name: 'Play Night Signal next' });
	await expect(nextButton).toBeEnabled();
	await nextButton.click();

	await expect.poll(() => queuedTrackIds).toEqual(['current', 'requested', 'middle']);
	await expect(nextButton).toContainText('Queued');
	await expect(page.locator('.queue-items p').nth(1)).toHaveText('Night Signal');
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
