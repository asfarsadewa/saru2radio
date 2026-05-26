import { defineConfig } from '@playwright/test';

const STUDIO_PORT = Number(process.env.STUDIO_PORT ?? 8011);

export default defineConfig({
	testDir: './tests',
	testMatch: /.*facade\.spec\.ts/,
	timeout: 30_000,
	use: {
		trace: 'retain-on-failure'
	},
	webServer: {
		command: 'npm run start',
		url: `http://127.0.0.1:${STUDIO_PORT}/`,
		reuseExistingServer: !process.env.CI,
		timeout: 60_000
	}
});
