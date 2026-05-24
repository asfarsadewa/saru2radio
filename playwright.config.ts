import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests',
	testMatch: /.*facade\.spec\.ts/,
	timeout: 30_000,
	use: {
		trace: 'retain-on-failure'
	},
	webServer: {
		command: 'npm run start',
		url: 'http://127.0.0.1:8011/',
		reuseExistingServer: !process.env.CI,
		timeout: 60_000
	}
});
