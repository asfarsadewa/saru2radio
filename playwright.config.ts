import { defineConfig } from '@playwright/test';
import path from 'node:path';

const STUDIO_PORT = Number(process.env.TEST_STUDIO_PORT ?? process.env.STUDIO_PORT ?? 18_011);
const PUBLIC_PORT = Number(process.env.TEST_PUBLIC_PORT ?? process.env.PUBLIC_PORT ?? 18_012);
const ICECAST_PORT = Number(process.env.TEST_ICECAST_PORT ?? 18_010);
const RUNTIME_DIR = path.resolve('.codex-runtime/e2e-runtime');
const FIXTURE_DIR = path.resolve('.codex-runtime/e2e-fixtures');
const FAKE_MIC_PATH = path.join(FIXTURE_DIR, 'fake-microphone.wav').replaceAll('\\', '/');

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 30_000,
	use: {
		trace: 'retain-on-failure',
		launchOptions: {
			args: [
				'--autoplay-policy=no-user-gesture-required',
				'--use-fake-ui-for-media-stream',
				'--use-fake-device-for-media-stream',
				`--use-file-for-fake-audio-capture=${FAKE_MIC_PATH}`
			]
		}
	},
	webServer: [
		{
			command: 'bun run test:e2e:icecast',
			url: `http://127.0.0.1:${ICECAST_PORT}/`,
			env: { TEST_ICECAST_PORT: String(ICECAST_PORT) },
			reuseExistingServer: false,
			timeout: 30_000
		},
		{
			// Generate isolated audio/runtime fixtures before the real app server
			// starts. Icecast process spawning stays disabled, but source traffic is
			// sent to the fake receiver above and recorded by the browser tests.
			command: 'bun run build && bun run test:e2e:prepare && bun run start',
			url: `http://127.0.0.1:${STUDIO_PORT}/`,
			env: {
				STUDIO_PORT: String(STUDIO_PORT),
				PUBLIC_PORT: String(PUBLIC_PORT),
				SARU2RADIO_SKIP_ICECAST: '1',
				SARU2RADIO_ICECAST_PORT: String(ICECAST_PORT),
				SARU2RADIO_RUNTIME_DIR: RUNTIME_DIR,
				SARU2RADIO_E2E_FIXTURE_DIR: FIXTURE_DIR
			},
			reuseExistingServer: false,
			timeout: 60_000
		}
	]
});
