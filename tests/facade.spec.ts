import { test, expect } from '@playwright/test';

test('studio dashboard renders local booth controls', async ({ page }) => {
	await page.goto('http://127.0.0.1:8011/');
	await expect(page.getByRole('heading', { name: 'saru2radio' })).toBeVisible();
	await expect(page.getByRole('button', { name: /ON AIR/i })).toBeVisible();
	await expect(page.getByText('Broadcast copies')).toBeVisible();
});

test('public facade renders listener page and hides studio API', async ({ page, request }) => {
	await page.goto('http://127.0.0.1:8012/');
	await expect(page.getByRole('heading', { name: 'saru2radio' })).toBeVisible();
	await expect(page.getByRole('button')).toBeDisabled();

	const apiResponse = await request.get('http://127.0.0.1:8012/api/config');
	expect(apiResponse.status()).toBe(404);

	const statusResponse = await request.get('http://127.0.0.1:8012/status.json');
	expect(statusResponse.ok()).toBe(true);
	const status = await statusResponse.json();
	expect(status.icecastUrl).toBe('');
});
