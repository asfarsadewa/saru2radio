import { defineConfig } from '@playwright/test';

const STUDIO_PORT = Number(process.env.TEST_STUDIO_PORT ?? process.env.STUDIO_PORT ?? 18_011);
const PUBLIC_PORT = Number(process.env.TEST_PUBLIC_PORT ?? process.env.PUBLIC_PORT ?? 18_012);

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 30_000,
	use: {
		trace: 'retain-on-failure'
	},
	webServer: {
		// Build first so a fresh clone can run `bun run test:e2e` directly. The
		// suite never touches the real stream path, so Icecast is skipped by
		// default; set SARU2RADIO_E2E_REAL_ICECAST=1 to exercise the genuine
		// Icecast integration on a machine that has the binary.
		command: 'bun run build && bun run start',
		url: `http://127.0.0.1:${STUDIO_PORT}/`,
		env: {
			STUDIO_PORT: String(STUDIO_PORT),
			PUBLIC_PORT: String(PUBLIC_PORT),
			SARU2RADIO_SKIP_ICECAST: process.env.SARU2RADIO_E2E_REAL_ICECAST === '1' ? '' : '1'
		},
		reuseExistingServer: false,
		timeout: 60_000
	}
});
