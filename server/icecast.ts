import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ICECAST_DIR, ICECAST_EXE, RUNTIME_DIR } from './paths.js';

export type IcecastRuntimeConfig = {
	port: number;
	host: string;
	mount: string;
	sourcePassword: string;
	adminPassword: string;
	configPath: string;
};

const DEFAULT_ICECAST = {
	port: 8010,
	host: '127.0.0.1',
	mount: '/live.mp3'
};

let icecastProcess: ChildProcessWithoutNullStreams | null = null;

export async function ensureIcecastRuntime(): Promise<IcecastRuntimeConfig> {
	await fs.mkdir(RUNTIME_DIR, { recursive: true });
	const runtimePath = path.join(RUNTIME_DIR, 'runtime.json');
	const configPath = path.join(RUNTIME_DIR, 'icecast.xml');
	let existing: Partial<IcecastRuntimeConfig> = {};

	try {
		existing = JSON.parse(await fs.readFile(runtimePath, 'utf8')) as Partial<IcecastRuntimeConfig>;
	} catch {
		existing = {};
	}

	const runtime: IcecastRuntimeConfig = {
		port: existing.port ?? DEFAULT_ICECAST.port,
		host: existing.host ?? DEFAULT_ICECAST.host,
		mount: existing.mount ?? DEFAULT_ICECAST.mount,
		sourcePassword: existing.sourcePassword ?? randomSecret(),
		adminPassword: existing.adminPassword ?? randomSecret(),
		configPath
	};

	await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
	await writeIcecastXml(runtime);
	return runtime;
}

export async function startIcecast(runtime: IcecastRuntimeConfig): Promise<void> {
	if (await isIcecastReachable(runtime)) {
		return;
	}

	await fs.access(ICECAST_EXE);
	icecastProcess = spawn(ICECAST_EXE, ['-c', runtime.configPath], {
		cwd: ICECAST_DIR,
		stdio: 'pipe',
		windowsHide: true
	});

	icecastProcess.stdout.on('data', (chunk) => process.stdout.write(`[icecast] ${chunk}`));
	icecastProcess.stderr.on('data', (chunk) => process.stderr.write(`[icecast] ${chunk}`));
	icecastProcess.on('exit', (code) => {
		if (icecastProcess) {
			console.log(`[icecast] exited with code ${code ?? 'unknown'}`);
		}
		icecastProcess = null;
	});

	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (await isIcecastReachable(runtime)) {
			return;
		}
		await delay(250);
	}

	throw new Error('Icecast did not become reachable on 127.0.0.1:8010.');
}

export function stopIcecastProcess(): void {
	icecastProcess?.kill();
	icecastProcess = null;
}

export async function isIcecastReachable(runtime: IcecastRuntimeConfig): Promise<boolean> {
	return new Promise((resolve) => {
		const request = http.get(
			{
				host: runtime.host,
				port: runtime.port,
				path: '/',
				timeout: 800
			},
			(response) => {
				response.resume();
				resolve((response.statusCode ?? 0) > 0);
			}
		);
		request.on('error', () => resolve(false));
		request.on('timeout', () => {
			request.destroy();
			resolve(false);
		});
	});
}

export class IcecastSourceConnection {
	private request: http.ClientRequest | null = null;
	private connected = false;
	private token = 0;

	constructor(
		private readonly runtime: IcecastRuntimeConfig,
		private readonly stationName: string,
		private readonly onState: (connected: boolean) => void
	) {}

	connect(): void {
		const previousRequest = this.request;
		if (previousRequest) {
			previousRequest.end();
			previousRequest.destroy();
		}

		const token = (this.token += 1);
		const authorization = Buffer.from(`source:${this.runtime.sourcePassword}`).toString('base64');
		const request = http.request({
			host: this.runtime.host,
			port: this.runtime.port,
			method: 'PUT',
			path: this.runtime.mount,
			headers: {
				Authorization: `Basic ${authorization}`,
				'Content-Type': 'audio/mpeg',
				'Ice-Name': this.stationName,
				'Ice-Genre': 'retro',
				'Ice-Public': '0'
			}
		});
		this.request = request;

		request.on('socket', (socket) => {
			socket.setNoDelay(true);
		});
		request.on('response', (response) => {
			if ((response.statusCode ?? 500) >= 300) {
				this.clearCurrentRequest(request, token);
				request.destroy();
			}
			response.resume();
		});
		request.on('error', () => this.clearCurrentRequest(request, token));
		request.on('close', () => this.clearCurrentRequest(request, token));
		request.flushHeaders();
		this.setConnected(true);
	}

	write(chunk: Buffer): void {
		if (!this.request || !this.connected) {
			return;
		}
		this.request.write(chunk);
	}

	disconnect(): void {
		const request = this.request;
		this.token += 1;
		this.request = null;
		if (request) {
			request.end();
			request.destroy();
		}
		this.setConnected(false);
	}

	isConnected(): boolean {
		return this.connected;
	}

	private clearCurrentRequest(request: http.ClientRequest, token: number): void {
		if (this.request !== request || this.token !== token) {
			return;
		}
		this.request = null;
		this.setConnected(false);
	}

	private setConnected(connected: boolean): void {
		if (this.connected === connected) {
			return;
		}
		this.connected = connected;
		this.onState(connected);
	}
}

function randomSecret(): string {
	return crypto.randomBytes(18).toString('base64url');
}

async function writeIcecastXml(runtime: IcecastRuntimeConfig): Promise<void> {
	const logDir = path.join(RUNTIME_DIR, 'icecast-log');
	await fs.mkdir(logDir, { recursive: true });
	const xml = `<!-- Generated by saru2radio. Secrets are stored in .saru2radio/runtime.json. -->
<icecast>
  <location>local</location>
  <admin>saru2radio@localhost</admin>
  <hostname>127.0.0.1</hostname>
  <limits>
    <clients>200</clients>
    <sources>1</sources>
    <queue-size>524288</queue-size>
    <client-timeout>30</client-timeout>
    <header-timeout>15</header-timeout>
    <source-timeout>10</source-timeout>
    <burst-on-connect>1</burst-on-connect>
    <burst-size>65535</burst-size>
  </limits>
  <authentication>
    <source-password>${escapeXml(runtime.sourcePassword)}</source-password>
    <relay-password>${escapeXml(runtime.sourcePassword)}</relay-password>
    <admin-user>admin</admin-user>
    <admin-password>${escapeXml(runtime.adminPassword)}</admin-password>
  </authentication>
  <listen-socket>
    <port>${runtime.port}</port>
    <bind-address>${runtime.host}</bind-address>
  </listen-socket>
  <mount>
    <mount-name>${runtime.mount}</mount-name>
    <password>${escapeXml(runtime.sourcePassword)}</password>
    <max-listeners>200</max-listeners>
    <public>0</public>
  </mount>
  <fileserve>1</fileserve>
  <paths>
    <basedir>${escapeXml(ICECAST_DIR)}</basedir>
    <logdir>${escapeXml(logDir)}</logdir>
    <webroot>${escapeXml(path.join(ICECAST_DIR, 'web'))}</webroot>
    <adminroot>${escapeXml(path.join(ICECAST_DIR, 'admin'))}</adminroot>
    <alias source="/" destination="/status.xsl"/>
  </paths>
  <logging>
    <accesslog>access.log</accesslog>
    <errorlog>error.log</errorlog>
    <playlistlog>playlist.log</playlistlog>
    <loglevel>3</loglevel>
    <logsize>10000</logsize>
  </logging>
  <security>
    <chroot>0</chroot>
  </security>
</icecast>
`;
	await fs.writeFile(runtime.configPath, xml);
}

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
