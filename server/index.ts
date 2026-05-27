import 'dotenv/config';
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
import { ActiveListenerCounter } from './listener-count.js';
import { DIST_DIR } from './paths.js';
import { ListenerMessageStore, ListenerMessageValidationError } from './listener-messages.js';
import { DirectMp3Playout } from './playout.js';
import {
	createRateLimitMiddleware,
	createStudioOriginGuard,
	FixedWindowRateLimiter,
	isAllowedStudioOrigin,
	listenerRequestKey,
	rejectForbiddenUpgrade
} from './security.js';
import { BrowserSourceSessionGuard } from './source-session.js';
import { SourceStreamPacer } from './source-pacer.js';
import { StudioStateStore } from './studio-state.js';
import { hasCloudflared, TunnelManager } from './tunnel.js';
import { AiDjActionStore, createAiDjAgent, type AiDjRequestAgent } from './ai-dj.js';

const STATION_NAME = 'saru2radio';
const STUDIO_PORT = Number(process.env.STUDIO_PORT ?? 8011);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 8012);
const BITRATE_KBPS = Number(process.env.RADIO_BITRATE_KBPS ?? 128);
const LISTENER_REQUEST_LIMIT = Number(process.env.LISTENER_REQUEST_LIMIT ?? 6);
const LISTENER_REQUEST_WINDOW_MS = Number(process.env.LISTENER_REQUEST_WINDOW_MS ?? 60_000);
const AI_DJ_ENABLED = process.env.AI_DJ_ENABLED?.toLowerCase() !== 'false';
const AI_DJ_MODEL = process.env.OPENAI_MODEL?.trim() || 'gpt-5.5';
const AI_DJ_MIN_CONFIDENCE = Number(process.env.AI_DJ_MIN_CONFIDENCE ?? 0.72);
const SOURCE_RECONNECT_DELAY_MS = 500;

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
const listenerMessages = new ListenerMessageStore();
const aiDjActions = new AiDjActionStore();
const activeListeners = new ActiveListenerCounter();
const browserSourceSessions = new BrowserSourceSessionGuard();
const tunnel = new TunnelManager();
let source: IcecastSourceConnection;
let playout: DirectMp3Playout;
let aiDj: AiDjRequestAgent;
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
			activeListeners.reset();
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
	aiDj = createAiDjAgent({
		actions: aiDjActions,
		apiKey: process.env.OPENAI_API_KEY,
		model: AI_DJ_MODEL,
		enabled: AI_DJ_ENABLED,
		minConfidence: AI_DJ_MIN_CONFIDENCE,
		getReadyTracks: currentReadyTracks,
		isDirectSongsActive,
		playNow: playAiDjTrackNow
	});

	const studioApp = createStudioApp();
	const studioServer = createServer(studioApp);
	attachStudioSockets(studioServer);
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
	app.use('/api', createStudioOriginGuard(STUDIO_PORT));
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
			cloudflaredAvailable,
			aiDj: aiDj.config()
		};
		response.json(config);
	});

	app.get('/api/status', (_request, response) => response.json(currentStatus()));
	app.get('/api/listener-messages', (_request, response) => response.json(listenerMessages.list()));
	app.delete('/api/listener-messages/:id', (request, response) => {
		response.json(listenerMessages.delete(request.params.id));
	});
	app.delete('/api/listener-messages', (_request, response) => {
		response.json(listenerMessages.clear());
	});
	app.get('/api/ai-dj/actions', (_request, response) => response.json(aiDjActions.list()));
	app.delete('/api/ai-dj/actions', (_request, response) => {
		response.json(aiDjActions.clear());
	});
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
	app.get('/api/monitor/live.mp3', (request, response) => proxyLiveStream(request, response));

	app.post('/api/broadcast/start', async (request, response, next) => {
		try {
			const queue = resolveBroadcastQueue(request.body?.trackIds);
			await startDirectPlayout(queue);
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
	app.post('/api/broadcast/play-now', async (request, response, next) => {
		try {
			const queue = resolveBroadcastQueue(request.body?.trackIds);
			await startDirectPlayout(queue, { playNow: true });
			status = {
				...status,
				onAir: true,
				startedAt: status.startedAt ?? new Date().toISOString()
			};
			response.json(currentStatus());
		} catch (error) {
			next(error);
		}
	});
	app.post('/api/broadcast/queue', (request, response, next) => {
		try {
			const queue = resolveBroadcastQueue(request.body?.trackIds);
			playout.setQueue(queue);
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
		browserSourceSessions.invalidate();
		playout.stop();
		source.disconnect();
		activeListeners.reset();
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
	const listenerRequestLimiter = new FixedWindowRateLimiter({
		limit: LISTENER_REQUEST_LIMIT,
		windowMs: LISTENER_REQUEST_WINDOW_MS
	});
	app.disable('x-powered-by');
	app.use('/assets', express.static(path.join(DIST_DIR, 'assets'), { immutable: true, maxAge: '1h' }));

	app.get('/', (_request, response) => response.sendFile(path.join(DIST_DIR, 'listener.html')));
	app.get('/status.json', (request, response) => response.json(publicStatus(request)));
	app.get('/now-playing.json', (_request, response) => response.json(nowPlaying));
	app.post(
		'/requests',
		createRateLimitMiddleware(listenerRequestLimiter, listenerRequestKey),
		express.json({ limit: '8kb' }),
		(request, response) => {
			if (!status.onAir) {
				response.status(409).type('text/plain').send('The station is off air.');
				return;
			}

			try {
				const listenerMessage = listenerMessages.create(request.body ?? {});
				try {
					aiDj.enqueue(listenerMessage);
				} catch (error) {
					console.error(`[ai-dj] ${error instanceof Error ? error.message : error}`);
				}
				response.status(201).json(listenerMessage);
			} catch (error) {
				if (error instanceof ListenerMessageValidationError) {
					response.status(400).type('text/plain').send(error.message);
					return;
				}
				throw error;
			}
		}
	);
	app.get('/live.mp3', (request, response) => proxyLiveStream(request, response, { countActiveListener: true }));
	app.use((_request, response) => response.status(404).type('text/plain').send('Not found'));
	return app;
}

function proxyLiveStream(
	request: express.Request,
	response: express.Response,
	options: { countActiveListener?: boolean } = {}
) {
	if (!status.onAir) {
		response.status(503).type('text/plain').send('saru2radio is off air.');
		return;
	}

	request.socket.setNoDelay(true);
	response.socket?.setNoDelay(true);
	let releaseActiveListener: (() => void) | null = null;
	const releaseOnce = () => {
		releaseActiveListener?.();
		releaseActiveListener = null;
	};
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
			if (options.countActiveListener) {
				releaseActiveListener = activeListeners.register();
				response.on('close', releaseOnce);
				response.on('error', releaseOnce);
				response.on('finish', releaseOnce);
				upstreamResponse.on('close', releaseOnce);
				upstreamResponse.on('end', releaseOnce);
				upstreamResponse.on('error', releaseOnce);
			}
			response.writeHead(200, {
				'content-type': 'audio/mpeg',
				'cache-control': 'no-store, no-transform',
				'connection': 'keep-alive',
				'x-accel-buffering': 'no'
			});
			response.flushHeaders();
			upstreamResponse.pipe(response);
		}
	);
	upstream.on('socket', (socket) => {
		socket.setNoDelay(true);
	});
	upstream.on('error', () => {
		releaseOnce();
		if (!response.headersSent) {
			response.status(502).type('text/plain').send('Could not reach Icecast.');
		}
	});
	request.on('close', () => {
		releaseOnce();
		upstream.destroy();
	});
}

function attachStudioSockets(server: ReturnType<typeof createServer>) {
	const sourceSocketServer = new WebSocketServer({ noServer: true });
	const talkBreakSocketServer = new WebSocketServer({ noServer: true });

	attachSourceSocket(sourceSocketServer);
	attachTalkBreakSocket(talkBreakSocketServer);

	server.on('upgrade', (request, socket, head) => {
		const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
		const socketServer = pathname === '/source' ? sourceSocketServer : pathname === '/talk-break' ? talkBreakSocketServer : null;
		if (!socketServer) {
			socket.destroy();
			return;
		}
		if (!isAllowedStudioOrigin(request.headers.origin, STUDIO_PORT)) {
			rejectForbiddenUpgrade(socket);
			return;
		}

		socketServer.handleUpgrade(request, socket, head, (webSocket) => {
			socketServer.emit('connection', webSocket, request);
		});
	});
}

function attachSourceSocket(socketServer: WebSocketServer) {
	socketServer.on('connection', (socket) => {
		let sessionId = 0;
		let connectTimer: ReturnType<typeof setTimeout> | null = null;
		const stopLiveSource = () => {
			if (connectTimer) {
				clearTimeout(connectTimer);
				connectTimer = null;
			}
			if (browserSourceSessions.endIfActive(sessionId)) {
				markOffAir();
			}
			sessionId = 0;
		};
		socket.on('message', (data, isBinary) => {
			if (!isBinary) {
				const message = JSON.parse(data.toString()) as { type?: string; bitrateKbps?: number };
				if (message.type === 'start') {
					const wasPlayoutRunning = playout.isRunning();
					sessionId = browserSourceSessions.begin();
					playout.stop();
					if (connectTimer) {
						clearTimeout(connectTimer);
					}
					connectTimer = setTimeout(
						() => {
							connectTimer = null;
							if (browserSourceSessions.isActive(sessionId)) {
								source.connect();
							}
						},
						wasPlayoutRunning ? SOURCE_RECONNECT_DELAY_MS : 0
					);
					status = {
						...status,
						onAir: true,
						startedAt: status.startedAt ?? new Date().toISOString()
					};
				} else if (message.type === 'stop') {
					stopLiveSource();
				}
				return;
			}

			const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
			if (!browserSourceSessions.isActive(sessionId)) {
				return;
			}
			source.write(chunk);
		});
		socket.on('close', stopLiveSource);
		socket.on('error', stopLiveSource);
	});
}

function attachTalkBreakSocket(socketServer: WebSocketServer) {
	socketServer.on('connection', (socket) => {
		let pacer: SourceStreamPacer | null = null;
		const stopTalkBreak = () => {
			if (pacer) {
				pacer.flush();
				pacer.stop();
				pacer = null;
			}
			playout.resume();
		};

		socket.on('message', (data, isBinary) => {
			if (!isBinary) {
				const message = JSON.parse(data.toString()) as { type?: string; bitrateKbps?: number };
				if (message.type === 'begin') {
					if (!status.onAir || !playout.isRunning()) {
						return;
					}

					stopTalkBreak();
					playout.pause();
					pacer = new SourceStreamPacer(source, message.bitrateKbps ?? BITRATE_KBPS, {
						prebufferSeconds: 0.2,
						maxWaitMs: 350,
						minBytesPerTick: 256
					});
				} else if (message.type === 'end') {
					stopTalkBreak();
				}
				return;
			}

			const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
			pacer?.push(chunk);
		});
		socket.on('close', stopTalkBreak);
		socket.on('error', stopTalkBreak);
	});
}

async function startDirectPlayout(queue: Track[], options: { playNow?: boolean } = {}): Promise<void> {
	const replacingBrowserSource = browserSourceSessions.hasActive();
	if (replacingBrowserSource) {
		browserSourceSessions.invalidate();
		source.disconnect();
		await wait(SOURCE_RECONNECT_DELAY_MS);
	}

	try {
		if (options.playNow) {
			playout.playNow(queue);
		} else {
			playout.start(queue);
		}
		if (!replacingBrowserSource) {
			browserSourceSessions.invalidate();
		}
	} catch (error) {
		if (replacingBrowserSource) {
			markOffAir();
		}
		throw error;
	}
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
		sourceConnected: false,
		activeListeners: activeListeners.count
	};
}

function currentStatus(): BroadcastStatus {
	return {
		...status,
		tunnelUrl: tunnel.getState().url,
		sourceConnected: source?.isConnected() ?? status.sourceConnected,
		activeListeners: activeListeners.count
	};
}

function resolveBroadcastQueue(trackIds: unknown): Track[] {
	const requestedIds = Array.isArray(trackIds) ? trackIds.map(String) : [];
	if (requestedIds.length === 0) {
		return currentReadyTracks();
	}

	return requestedIds.map((id) => library.getTrack(id)).filter((track): track is Track => Boolean(track?.cacheReady));
}

function currentReadyTracks(): Track[] {
	return library.getState().tracks.filter((track) => track.cacheReady);
}

function isDirectSongsActive(): boolean {
	return Boolean(status?.onAir && playout?.isRunning());
}

async function playAiDjTrackNow(track: Track): Promise<void> {
	const queue = cueAiDjTrack(track);
	await startDirectPlayout(queue, { playNow: true });
	status = {
		...status,
		onAir: true,
		startedAt: status.startedAt ?? new Date().toISOString()
	};
}

function cueAiDjTrack(track: Track): Track[] {
	const currentQueue = playout
		.getQueue()
		.filter((candidate) => candidate.cacheReady && candidate.id !== track.id);
	const fallbackQueue = currentReadyTracks().filter((candidate) => candidate.id !== track.id);
	const tail = currentQueue.length > 0 ? currentQueue : fallbackQueue;
	return [track, ...tail];
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

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOffAir(): void {
	source?.disconnect();
	activeListeners.reset();
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
