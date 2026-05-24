import express from 'express';
import { createServer } from 'node:http';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { BroadcastStatus, NowPlaying, ServerConfig, Track } from '../src/lib/types.js';
import { pickFolderWithDialog } from './folder-picker.js';
import {
	ensureIcecastRuntime,
	IcecastSourceConnection,
	startIcecast,
	stopIcecastProcess,
	type IcecastRuntimeConfig
} from './icecast.js';
import { LibraryManager, resolveRadioToolPath } from './library.js';
import { DIST_DIR } from './paths.js';
import { DirectMp3Playout } from './playout.js';
import { StudioStateStore } from './studio-state.js';
import { hasCloudflared, TunnelManager } from './tunnel.js';

const STATION_NAME = 'saru2radio';
const STUDIO_PORT = Number(process.env.STUDIO_PORT ?? 8011);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 8012);
const BITRATE_KBPS = Number(process.env.RADIO_BITRATE_KBPS ?? 64);

let runtime: IcecastRuntimeConfig;
let status: BroadcastStatus;
let nowPlaying: NowPlaying = {
	trackId: null,
	title: 'Off air',
	artist: 'saru2radio',
	startedAt: null,
	duration: null
};

const radioToolPath = await resolveExistingPath(resolveRadioToolPath());
const library = new LibraryManager(radioToolPath);
const studioState = new StudioStateStore();
const tunnel = new TunnelManager();
let source: IcecastSourceConnection;
let playout: DirectMp3Playout;
let cloudflaredAvailable = false;

async function main() {
	runtime = await ensureIcecastRuntime();
	await startIcecast(runtime);
	cloudflaredAvailable = await hasCloudflared();
	await restoreBroadcastLibrary();
	status = createStatus();
	source = new IcecastSourceConnection(runtime, STATION_NAME, (connected) => {
		status.sourceConnected = connected;
	});
	playout = new DirectMp3Playout(source, {
		onTrack: (track) => {
			nowPlaying = {
				trackId: track.id,
				title: track.title,
				artist: track.artist,
				startedAt: new Date().toISOString(),
				duration: track.duration
			};
		},
		onStop: () => {
			status = createStatus();
			nowPlaying = {
				trackId: null,
				title: 'Off air',
				artist: STATION_NAME,
				startedAt: null,
				duration: null
			};
		},
		onError: (message) => {
			console.error(`[playout] ${message}`);
		}
	});

	const studioApp = createStudioApp();
	const studioServer = createServer(studioApp);
	attachSourceSocket(studioServer);
	studioServer.listen(STUDIO_PORT, '127.0.0.1', () => {
		console.log(`saru2radio studio: http://127.0.0.1:${STUDIO_PORT}`);
	});

	const publicApp = createPublicApp();
	publicApp.listen(PUBLIC_PORT, '127.0.0.1', () => {
		console.log(`saru2radio listener facade: http://127.0.0.1:${PUBLIC_PORT}`);
	});

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

function createStudioApp() {
	const app = express();
	app.disable('x-powered-by');
	app.use(express.json({ limit: '1mb' }));
	app.use(express.static(DIST_DIR));

	app.get('/api/config', (_request, response) => {
		const config: ServerConfig = {
			stationName: STATION_NAME,
			studioUrl: `http://127.0.0.1:${STUDIO_PORT}`,
			listenerUrl: listenerBaseUrl(),
			icecastUrl: `http://${runtime.host}:${runtime.port}${runtime.mount}`,
			mount: runtime.mount,
			bitrateKbps: BITRATE_KBPS,
			radioToolPath,
			cloudflaredAvailable
		};
		response.json(config);
	});

	app.get('/api/status', (_request, response) => response.json(currentStatus()));
	app.get('/api/studio-state', (_request, response) => response.json(studioState.get()));
	app.patch('/api/studio-state', async (request, response, next) => {
		try {
			response.json(
				await studioState.update({
					ordered: typeof request.body.ordered === 'boolean' ? request.body.ordered : undefined,
					broadcastRecursive:
						typeof request.body.broadcastRecursive === 'boolean' ? request.body.broadcastRecursive : undefined,
					prepDirectory: typeof request.body.prepDirectory === 'string' ? request.body.prepDirectory : undefined
				})
			);
		} catch (error) {
			next(error);
		}
	});
	app.get('/api/now-playing', (_request, response) => response.json(nowPlaying));
	app.post('/api/now-playing', (request, response) => {
		nowPlaying = {
			trackId: request.body.trackId ?? null,
			title: String(request.body.title ?? 'Untitled'),
			artist: String(request.body.artist ?? 'Unknown artist'),
			startedAt: new Date().toISOString(),
			duration: typeof request.body.duration === 'number' ? request.body.duration : null
		};
		response.json(nowPlaying);
	});

	app.get('/api/library', (_request, response) => response.json(library.getState()));
	app.post('/api/library/pick-folder', async (_request, response, next) => {
		try {
			const directory = await pickFolderWithDialog();
			response.json({ directory });
		} catch (error) {
			next(error);
		}
	});
	app.post('/api/library/scan', async (request, response, next) => {
		try {
			const recursive = Boolean(request.body.recursive);
			const state = await library.scanBroadcast(String(request.body.directory ?? ''), { recursive });
			await studioState.update({
				broadcastDirectory: state.directory,
				broadcastRecursive: recursive
			});
			response.json(state);
		} catch (error) {
			next(error);
		}
	});
	app.post('/api/library/prepare', async (request, response, next) => {
		try {
			const trackIds = Array.isArray(request.body.trackIds) ? request.body.trackIds.map(String) : undefined;
			response.json(await library.prepare(trackIds, { continueOnError: true }));
		} catch (error) {
			next(error);
		}
	});
	app.get('/api/tracks/:id/cache', async (request, response, next) => {
		try {
			const track = library.getTrack(request.params.id);
			if (!track?.cacheReady) {
				response.status(404).send('Cached track not found.');
				return;
			}
			response.type('audio/mpeg');
			response.sendFile(track.playPath, { dotfiles: 'allow' });
		} catch (error) {
			next(error);
		}
	});

	app.post('/api/broadcast/start', (request, response, next) => {
		try {
			const requestedIds: string[] = Array.isArray(request.body?.trackIds) ? request.body.trackIds.map(String) : [];
			const queue: Track[] =
				requestedIds.length > 0
					? requestedIds.map((id: string) => library.getTrack(id)).filter((track): track is Track => Boolean(track?.cacheReady))
					: library.getState().tracks.filter((track) => track.cacheReady);
			playout.start(queue);
			status = {
				...status,
				onAir: true,
				startedAt: new Date().toISOString()
			};
			response.json(currentStatus());
		} catch (error) {
			next(error);
		}
	});
	app.post('/api/broadcast/skip', (_request, response) => {
		playout.skip();
		response.json(currentStatus());
	});
	app.post('/api/broadcast/stop', (_request, response) => {
		playout.stop();
		source.disconnect();
		status = createStatus();
		nowPlaying = {
			trackId: null,
			title: 'Off air',
			artist: STATION_NAME,
			startedAt: null,
			duration: null
		};
		response.json(currentStatus());
	});

	app.get('/api/tunnel', (_request, response) => response.json(tunnel.getState()));
	app.post('/api/tunnel/start', (_request, response) => {
		const state = tunnel.start(`http://127.0.0.1:${PUBLIC_PORT}`);
		status.tunnelUrl = state.url;
		response.json(state);
	});
	app.post('/api/tunnel/stop', (_request, response) => {
		const state = tunnel.stop();
		status.tunnelUrl = state.url;
		response.json(state);
	});

	app.get('/', (_request, response) => response.sendFile(path.join(DIST_DIR, 'studio.html')));
	app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
		response.status(500).send(error instanceof Error ? error.message : 'Unexpected server error.');
	});

	return app;
}

function createPublicApp() {
	const app = express();
	app.disable('x-powered-by');
	app.use('/assets', express.static(path.join(DIST_DIR, 'assets'), { immutable: true, maxAge: '1h' }));

	app.get('/', (_request, response) => response.sendFile(path.join(DIST_DIR, 'listener.html')));
	app.get('/status.json', (request, response) => response.json(publicStatus(request)));
	app.get('/now-playing.json', (_request, response) => response.json(nowPlaying));
	app.get('/live.mp3', (request, response) => {
		if (!status.onAir) {
			response.status(503).type('text/plain').send('saru2radio is off air.');
			return;
		}

		const upstream = http.get(
			{
				host: runtime.host,
				port: runtime.port,
				path: runtime.mount,
				timeout: 5000
			},
			(upstreamResponse) => {
				if ((upstreamResponse.statusCode ?? 500) >= 400) {
					response.status(503).type('text/plain').send('Stream source is not connected.');
					upstreamResponse.resume();
					return;
				}
				response.writeHead(200, {
					'content-type': 'audio/mpeg',
					'cache-control': 'no-store'
				});
				upstreamResponse.pipe(response);
			}
		);
		upstream.on('error', () => {
			if (!response.headersSent) {
				response.status(502).type('text/plain').send('Could not reach Icecast.');
			}
		});
		request.on('close', () => upstream.destroy());
	});
	app.use((_request, response) => response.status(404).type('text/plain').send('Not found'));
	return app;
}

function attachSourceSocket(server: ReturnType<typeof createServer>) {
	const socketServer = new WebSocketServer({ server, path: '/source' });
	socketServer.on('connection', (socket) => {
		socket.on('message', (data, isBinary) => {
			if (!isBinary) {
				const message = JSON.parse(data.toString()) as { type?: string };
				if (message.type === 'start') {
					playout.stop(false);
					source.connect();
					status = {
						...status,
						onAir: true,
						startedAt: status.startedAt ?? new Date().toISOString()
					};
				} else if (message.type === 'stop') {
					markOffAir();
				}
				return;
			}

			source.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
		});
		socket.on('close', () => markOffAir());
		socket.on('error', () => markOffAir());
	});
}

function createStatus(): BroadcastStatus {
	return {
		onAir: false,
		streamUrl: `${listenerBaseUrl()}/live.mp3`,
		stationName: STATION_NAME,
		startedAt: null,
		icecastUrl: `http://${runtime.host}:${runtime.port}${runtime.mount}`,
		listenerUrl: listenerBaseUrl(),
		tunnelUrl: tunnel.getState().url,
		sourceConnected: false
	};
}

function currentStatus(): BroadcastStatus {
	return {
		...status,
		tunnelUrl: tunnel.getState().url,
		sourceConnected: source?.isConnected() ?? status.sourceConnected
	};
}

function publicStatus(request: express.Request): BroadcastStatus {
	const protocol = request.get('x-forwarded-proto') ?? request.protocol;
	const host = request.get('host') ?? `127.0.0.1:${PUBLIC_PORT}`;
	return {
		...currentStatus(),
		streamUrl: `${protocol}://${host}/live.mp3`,
		listenerUrl: `${protocol}://${host}`,
		icecastUrl: ''
	};
}

function listenerBaseUrl(): string {
	return tunnel.getListenerUrl(`http://127.0.0.1:${PUBLIC_PORT}`);
}

async function restoreBroadcastLibrary(): Promise<void> {
	const saved = await studioState.load();
	if (!saved.broadcastDirectory) {
		return;
	}

	try {
		await library.scanBroadcast(saved.broadcastDirectory, { recursive: saved.broadcastRecursive });
	} catch (error) {
		console.warn(`[library] could not restore ${saved.broadcastDirectory}: ${error instanceof Error ? error.message : error}`);
	}
}

function markOffAir(): void {
	source?.disconnect();
	status = createStatus();
	nowPlaying = {
		trackId: null,
		title: 'Off air',
		artist: STATION_NAME,
		startedAt: null,
		duration: null
	};
}

async function resolveExistingPath(filePath: string | null): Promise<string | null> {
	if (!filePath) {
		return null;
	}
	try {
		await fs.access(filePath);
		return filePath;
	} catch {
		return null;
	}
}

function shutdown() {
	tunnel.stop();
	source?.disconnect();
	stopIcecastProcess();
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
