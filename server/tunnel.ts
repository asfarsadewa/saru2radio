import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TunnelState } from '../src/lib/types.js';
import { RUNTIME_DIR } from './paths.js';

export class TunnelManager {
	private process: ChildProcessWithoutNullStreams | null = null;
	private state: TunnelState = {
		running: false,
		url: null,
		startedAt: null,
		error: null
	};

	getState(): TunnelState {
		return { ...this.state };
	}

	start(targetUrl: string): TunnelState {
		if (this.process) {
			return this.getState();
		}

		mkdirSync(RUNTIME_DIR, { recursive: true });
		const quickConfigPath = path.join(RUNTIME_DIR, 'cloudflared-quick.yml');
		writeFileSync(quickConfigPath, 'no-autoupdate: true\n');

		this.state = {
			running: true,
			url: null,
			startedAt: new Date().toISOString(),
			error: null
		};
		this.process = spawn('cloudflared', ['tunnel', '--config', quickConfigPath, '--url', targetUrl], {
			windowsHide: true,
			stdio: 'pipe'
		});

		const handleOutput = (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
			if (match) {
				this.state.url = match[0];
			}
			if (/ERR|error/i.test(text) && !match) {
				this.state.error = text.trim().slice(0, 500);
			}
		};

		this.process.stdout.on('data', handleOutput);
		this.process.stderr.on('data', handleOutput);
		this.process.on('exit', (code) => {
			this.process = null;
			this.state.running = false;
			if (code && !this.state.error) {
				this.state.error = `cloudflared exited with code ${code}`;
			}
		});

		return this.getState();
	}

	stop(): TunnelState {
		this.process?.kill();
		this.process = null;
		this.state.running = false;
		return this.getState();
	}
}

export async function hasCloudflared(): Promise<boolean> {
	return new Promise((resolve) => {
		const check = spawn('cloudflared', ['--version'], { windowsHide: true, stdio: 'ignore' });
		check.on('error', () => resolve(false));
		check.on('exit', (code) => resolve(code === 0));
	});
}
