import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { IcecastSourceConnection, type IcecastRuntimeConfig } from '../server/icecast.js';

let server: Server | null = null;
let connection: IcecastSourceConnection | null = null;

describe('IcecastSourceConnection', () => {
	afterEach(async () => {
		connection?.disconnect();
		connection = null;
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = null;
		}
	});

	it('ignores stale close events from a replaced source request', async () => {
		let requestCount = 0;
		server = await listen((request) => {
			requestCount += 1;
			request.resume();
		});
		const states: boolean[] = [];
		connection = new IcecastSourceConnection(runtimeFor(server), 'test', (connected) => states.push(connected));

		connection.connect();
		await waitFor(() => requestCount === 1);
		connection.connect();
		await waitFor(() => requestCount === 2);
		await delay(50);

		expect(connection.isConnected()).toBe(true);
		expect(states.at(-1)).toBe(true);
	});

	it('marks the current source disconnected when Icecast rejects the mount', async () => {
		server = await listen((_request, response) => {
			response.writeHead(409);
			response.end('mountpoint in use');
		});
		const states: boolean[] = [];
		connection = new IcecastSourceConnection(runtimeFor(server), 'test', (connected) => states.push(connected));

		connection.connect();
		await waitFor(() => connection?.isConnected() === false && states.includes(false));

		expect(states).toEqual([true, false]);
	});
});

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function listen(handler: RequestHandler): Promise<Server> {
	const nextServer = createServer(handler);
	await new Promise<void>((resolve) => nextServer.listen(0, '127.0.0.1', resolve));
	return nextServer;
}

function runtimeFor(target: Server): IcecastRuntimeConfig {
	const address = target.address();
	if (!address || typeof address === 'string') {
		throw new Error('Test server did not expose a TCP port.');
	}
	return {
		host: '127.0.0.1',
		port: address.port,
		mount: '/live.mp3',
		sourcePassword: 'source-password',
		adminPassword: 'admin-password',
		configPath: 'test.xml'
	};
}

async function waitFor(predicate: () => boolean | undefined): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) {
			return;
		}
		await delay(10);
	}
	throw new Error('Timed out waiting for condition.');
}
