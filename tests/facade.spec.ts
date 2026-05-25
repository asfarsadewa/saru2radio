import { test, expect } from '@playwright/test';

test('studio dashboard renders local booth controls', async ({ page }) => {
	await page.goto('http://127.0.0.1:8011/');
	await expect(page.getByRole('heading', { name: 'saru2radio' })).toBeVisible();
	await expect(page.getByRole('button', { name: /(ON|OFF) AIR/i })).toBeVisible();
	await expect(page.getByText('Broadcast library')).toBeVisible();
	await expect(page.getByText('listener requests', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: /No mic/i })).toBeDisabled();
});

test('public facade renders listener page and hides studio API', async ({ page, request }) => {
	await page.goto('http://127.0.0.1:8012/');
	await expect(page.getByRole('heading', { name: 'saru2radio' })).toBeVisible();
	await expect(page.getByText('request line')).toBeVisible();

	const apiResponse = await request.get('http://127.0.0.1:8012/api/config');
	expect(apiResponse.status()).toBe(404);
	const messagesResponse = await request.get('http://127.0.0.1:8012/api/listener-messages');
	expect(messagesResponse.status()).toBe(404);

	const statusResponse = await request.get('http://127.0.0.1:8012/status.json');
	expect(statusResponse.ok()).toBe(true);
	const status = await statusResponse.json();
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
