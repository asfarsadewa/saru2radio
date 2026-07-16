import { defineConfig } from '@playwright/test';

const STUDIO_PORT = Number(process.env.TEST_STUDIO_PORT ?? process.env.STUDIO_PORT ?? 18_011);
const PUBLIC_PORT = Number(process.env.TEST_PUBLIC_PORT ?? process.env.PUBLIC_PORT ?? 18_012);

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
		env: {
			STUDIO_PORT: String(STUDIO_PORT),
			PUBLIC_PORT: String(PUBLIC_PORT)
		},
		reuseExistingServer: false,
		timeout: 60_000
	}
});
