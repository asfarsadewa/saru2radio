import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TunnelState } from '../src/lib/types.js';
import { RUNTIME_DIR } from './paths.js';

export const NAMED_TUNNEL_CONFIG_PATH = path.join(RUNTIME_DIR, 'cloudflare-named-tunnel.json');

export type NamedTunnelConfig = {
	mode: 'named';
	hostname: string;
	url: string;
	tunnelId?: string;
	tunnelName?: string;
	accountId?: string;
	zoneId?: string;
	service?: string;
	tokenPath?: string;
	token?: string;
};

type NamedTunnelConfigInput = Partial<NamedTunnelConfig>;

export function loadNamedTunnelConfig(configPath = process.env.SARU2RADIO_TUNNEL_CONFIG ?? NAMED_TUNNEL_CONFIG_PATH) {
	try {
		const configDirectory = path.dirname(configPath);
		const raw = JSON.parse(readFileSync(configPath, 'utf8')) as NamedTunnelConfigInput;
		const hostname = typeof raw.hostname === 'string' ? raw.hostname.trim() : '';
		const token = typeof raw.token === 'string' ? raw.token.trim() : undefined;
		const tokenPath =
			typeof raw.tokenPath === 'string' && raw.tokenPath.trim()
				? path.resolve(configDirectory, raw.tokenPath.trim())
				: undefined;

		if (!hostname || (!token && !tokenPath)) {
			return null;
		}
		if (tokenPath && !existsSync(tokenPath)) {
			return null;
		}

		return {
			...raw,
			mode: 'named' as const,
			hostname,
			url: normalizeTunnelUrl(raw.url, hostname),
			token,
			tokenPath
		};
	} catch {
		return null;
	}
}

export function buildNamedTunnelArgs(config: NamedTunnelConfig): string[] {
	const args = ['tunnel', '--no-autoupdate', 'run'];
	if (config.tokenPath) {
		return [...args, '--token-file', config.tokenPath];
	}
	return args;
}

// Inline tokens go through the environment instead of argv: a command line is
// visible to any local process enumeration, TUNNEL_TOKEN is not. A tokenPath
// remains the recommended option and needs no environment at all.
export function buildNamedTunnelEnv(config: NamedTunnelConfig): NodeJS.ProcessEnv {
	if (config.tokenPath || !config.token) {
		return {};
	}
	return { TUNNEL_TOKEN: config.token };
}

export class TunnelManager {
	private process: ChildProcessWithoutNullStreams | null = null;
	private stopping = false;
	private readonly namedConfig = loadNamedTunnelConfig();
	private state: TunnelState = {
		running: false,
		url: null,
		startedAt: null,
		error: null,
		mode: this.namedConfig ? 'named' : null,
		hostname: this.namedConfig?.hostname ?? null,
		configured: Boolean(this.namedConfig)
	};

	getState(): TunnelState {
		return { ...this.state };
	}

	getListenerUrl(fallbackUrl: string): string {
		return this.namedConfig?.url ?? fallbackUrl;
	}

	start(targetUrl: string): TunnelState {
		if (this.process) {
			return this.getState();
		}

		this.stopping = false;
		if (this.namedConfig) {
			return this.startNamedTunnel();
		}

		mkdirSync(RUNTIME_DIR, { recursive: true });
		const quickConfigPath = path.join(RUNTIME_DIR, 'cloudflared-quick.yml');
		writeFileSync(quickConfigPath, 'no-autoupdate: true\n');

		this.state = {
			running: true,
			url: null,
			startedAt: new Date().toISOString(),
			error: null,
			mode: 'quick',
			hostname: null,
			configured: false
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

		const process = this.process;
		process.stdout.on('data', handleOutput);
		process.stderr.on('data', handleOutput);
		process.on('exit', (code) => {
			if (this.process === process) {
				this.process = null;
			}
			this.state.running = false;
			this.state.url = null;
			this.state.startedAt = null;
			this.state.mode = this.namedConfig ? 'named' : null;
			this.state.hostname = this.namedConfig?.hostname ?? null;
			this.state.configured = Boolean(this.namedConfig);
			if (!this.stopping && code && !this.state.error) {
				this.state.error = `cloudflared exited with code ${code}`;
			}
			this.stopping = false;
		});

		return this.getState();
	}

	stop(): TunnelState {
		const process = this.process;
		this.stopping = true;
		if (process) {
			try {
				process.kill();
			} catch {
				if (this.process === process) {
					this.process = null;
				}
			}
			setTimeout(() => {
				if (this.process === process && process.exitCode === null) {
					process.kill('SIGKILL');
				}
			}, 1500).unref();
		}
		this.state = {
			running: false,
			url: null,
			startedAt: null,
			error: null,
			mode: this.namedConfig ? 'named' : null,
			hostname: this.namedConfig?.hostname ?? null,
			configured: Boolean(this.namedConfig)
		};
		return this.getState();
	}

	private startNamedTunnel(): TunnelState {
		if (!this.namedConfig) {
			return this.getState();
		}

		this.state = {
			running: true,
			url: this.namedConfig.url,
			startedAt: new Date().toISOString(),
			error: null,
			mode: 'named',
			hostname: this.namedConfig.hostname,
			configured: true
		};
		this.process = spawn('cloudflared', buildNamedTunnelArgs(this.namedConfig), {
			windowsHide: true,
			stdio: 'pipe',
			env: { ...globalThis.process.env, ...buildNamedTunnelEnv(this.namedConfig) }
		});

		const handleOutput = (chunk: Buffer) => {
			const text = chunk.toString('utf8');
			if (/ERR|error/i.test(text)) {
				this.state.error = text.trim().slice(0, 500);
			}
		};

		const process = this.process;
		process.stdout.on('data', handleOutput);
		process.stderr.on('data', handleOutput);
		process.on('exit', (code) => {
			if (this.process === process) {
				this.process = null;
			}
			this.state.running = false;
			this.state.url = null;
			this.state.startedAt = null;
			this.state.mode = 'named';
			this.state.hostname = this.namedConfig?.hostname ?? null;
			this.state.configured = true;
			if (!this.stopping && code && !this.state.error) {
				this.state.error = `cloudflared exited with code ${code}`;
			}
			this.stopping = false;
		});

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

function normalizeTunnelUrl(value: unknown, hostname: string): string {
	if (typeof value === 'string' && value.trim()) {
		return value.trim();
	}
	return `https://${hostname}`;
}
