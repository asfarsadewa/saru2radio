import { test, expect } from '@playwright/test';

const STUDIO_URL = `http://127.0.0.1:${process.env.STUDIO_PORT ?? 8011}`;
const PUBLIC_URL = `http://127.0.0.1:${process.env.PUBLIC_PORT ?? 8012}`;

test('studio dashboard renders local booth controls', async ({ page, request }) => {
	await page.goto(`${STUDIO_URL}/`);
	await expect(page.getByRole('heading', { name: 'saru2radio' })).toBeVisible();
	await expect(page.getByRole('button', { name: /(ON|OFF) AIR/i })).toBeVisible();
	await expect(page.getByText('Broadcast library')).toBeVisible();
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
