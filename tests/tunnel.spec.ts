import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNamedTunnelArgs, buildNamedTunnelEnv, loadNamedTunnelConfig } from '../server/tunnel.js';

describe('named tunnel config', () => {
	it('loads the permanent hostname with a relative token file', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'saru2radio-tunnel-'));
		const configPath = path.join(directory, 'cloudflare-named-tunnel.json');
		writeFileSync(path.join(directory, 'cloudflare-tunnel-token.txt'), 'test-token');
		writeFileSync(
			configPath,
			JSON.stringify({
				mode: 'named',
				hostname: 'saru2radio.com',
				tunnelId: 'test-tunnel',
				tokenPath: 'cloudflare-tunnel-token.txt'
			})
		);

		const config = loadNamedTunnelConfig(configPath);

		expect(config).toMatchObject({
			mode: 'named',
			hostname: 'saru2radio.com',
			url: 'https://saru2radio.com',
			tunnelId: 'test-tunnel'
		});
		expect(config?.tokenPath).toBe(path.join(directory, 'cloudflare-tunnel-token.txt'));
		expect(buildNamedTunnelArgs(config!)).toEqual([
			'tunnel',
			'--no-autoupdate',
			'run',
			'--token-file',
			path.join(directory, 'cloudflare-tunnel-token.txt')
		]);
		expect(buildNamedTunnelEnv(config!)).toEqual({});
	});

	it('passes inline tokens through the environment instead of the command line', () => {
		const config = {
			mode: 'named' as const,
			hostname: 'saru2radio.com',
			url: 'https://saru2radio.com',
			token: 'secret-token'
		};

		expect(buildNamedTunnelArgs(config)).toEqual(['tunnel', '--no-autoupdate', 'run']);
		expect(buildNamedTunnelEnv(config)).toEqual({ TUNNEL_TOKEN: 'secret-token' });
	});
});
