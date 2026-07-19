import { LiveMp3Encoder } from './liveMp3';

type SourceMode = 'source' | 'talk';

type MainRequest = {
	type: 'initialize' | 'begin-talk' | 'end-talk' | 'stop';
	requestId: number;
	mode?: SourceMode;
	sampleRate?: number;
	bitrateKbps?: number;
	socketUrl?: string;
	port?: MessagePort;
};

type CaptureMessage =
	| { type: 'pcm'; buffer: ArrayBuffer }
	| { type: 'capture-state'; active: boolean; requestId: number }
	| { type: 'closed'; requestId: number };

type WorkerResponse =
	| { type: 'response'; requestId: number; ok: true }
	| { type: 'response'; requestId: number; ok: false; error: string }
	| { type: 'source-state'; connected: boolean }
	| { type: 'error'; message: string };

type WorkerScope = {
	onmessage: ((event: MessageEvent<MainRequest>) => void) | null;
	postMessage(message: WorkerResponse): void;
};

const workerScope = self as unknown as WorkerScope;
const MAX_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 5000;

let mode: SourceMode | null = null;
let sampleRate = 0;
let bitrateKbps = 0;
let capturePort: MessagePort | null = null;
let socket: WebSocket | null = null;
let encoder: LiveMp3Encoder | null = null;
let captureActive = false;
let stopping = false;
let failed = false;
let captureRequestId = 0;
let commandChain = Promise.resolve();
const captureWaiters = new Map<
	number,
	{ resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
>();

workerScope.onmessage = (event) => {
	const request = event.data;
	commandChain = commandChain
		.then(() => handleRequest(request))
		.then(() => respond(request.requestId, true))
		.catch((error) => respond(request.requestId, false, errorMessage(error)));
};

async function handleRequest(request: MainRequest): Promise<void> {
	switch (request.type) {
		case 'initialize':
			await initialize(request);
			return;
		case 'begin-talk':
			await beginTalk();
			return;
		case 'end-talk':
			await endTalk();
			return;
		case 'stop':
			await stopSource();
	}
}

async function initialize(request: MainRequest): Promise<void> {
	if (!request.mode || !request.sampleRate || !request.bitrateKbps || !request.socketUrl || !request.port) {
		throw new Error('Encoder source worker received an incomplete initialization request.');
	}

	mode = request.mode;
	sampleRate = request.sampleRate;
	bitrateKbps = request.bitrateKbps;
	capturePort = request.port;
	capturePort.onmessage = (event: MessageEvent<CaptureMessage>) => handleCaptureMessage(event.data);
	capturePort.start();
	socket = await openSocket(request.socketUrl);
	socket.addEventListener('close', handleSocketClose);
	socket.addEventListener('error', handleSocketError);
	post({ type: 'source-state', connected: true });

	if (mode === 'source') {
		encoder = new LiveMp3Encoder(sampleRate, bitrateKbps);
		socket.send(JSON.stringify({ type: 'start', bitrateKbps }));
		await setCaptureActive(true);
	} else {
		await setCaptureActive(false);
	}
}

async function beginTalk(): Promise<void> {
	assertInitialized('begin a talk break');
	if (mode !== 'talk') {
		throw new Error('Talk-break capture is unavailable for this source.');
	}
	if (captureActive) {
		return;
	}

	encoder = new LiveMp3Encoder(sampleRate, bitrateKbps);
	socket?.send(JSON.stringify({ type: 'begin', bitrateKbps }));
	try {
		await setCaptureActive(true);
	} catch (error) {
		encoder = null;
		socket?.send(JSON.stringify({ type: 'end' }));
		void setCaptureActive(false).catch(() => undefined);
		throw error;
	}
}

async function endTalk(): Promise<void> {
	assertInitialized('end a talk break');
	if (mode !== 'talk' || !encoder) {
		return;
	}

	try {
		await setCaptureActive(false);
	} finally {
		flushEncoder();
		socket?.send(JSON.stringify({ type: 'end' }));
		encoder = null;
	}
}

async function stopSource(): Promise<void> {
	if (stopping) {
		return;
	}
	stopping = true;

	let captureError: unknown;
	if (capturePort && !failed) {
		try {
			await setCaptureActive(false);
		} catch (error) {
			captureError = error;
		}
	}
	if (encoder) {
		flushEncoder();
		if (mode === 'talk') {
			socket?.send(JSON.stringify({ type: 'end' }));
		} else {
			socket?.send(JSON.stringify({ type: 'stop' }));
		}
		encoder = null;
	}

	capturePort?.postMessage({ type: 'close', requestId: ++captureRequestId });
	capturePort?.close();
	capturePort = null;
	if (socket && socket.readyState < WebSocket.CLOSING) {
		socket.close();
	}
	socket = null;
	post({ type: 'source-state', connected: false });
	if (captureError) {
		throw captureError;
	}
}

function handleCaptureMessage(message: CaptureMessage): void {
	if (message.type === 'pcm') {
		if (failed) {
			return;
		}
		try {
			encodePcm(message.buffer);
		} catch (error) {
			failSource(errorMessage(error));
		}
		return;
	}

	if (message.type === 'capture-state') {
		captureActive = message.active;
		resolveCaptureRequest(message.requestId);
		return;
	}

	resolveCaptureRequest(message.requestId);
}

function encodePcm(buffer: ArrayBuffer): void {
	if (!encoder || !socket || socket.readyState !== WebSocket.OPEN) {
		return;
	}
	if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
		throw new Error('Source bridge is not draining encoded audio.');
	}

	for (const chunk of encoder.encode(new Float32Array(buffer))) {
		socket.send(chunk);
	}
}

function flushEncoder(): void {
	if (!encoder || !socket || socket.readyState !== WebSocket.OPEN) {
		return;
	}
	for (const chunk of encoder.flush()) {
		socket.send(chunk);
	}
}

function setCaptureActive(active: boolean): Promise<void> {
	if (!capturePort) {
		return Promise.reject(new Error('Encoder tap is not connected.'));
	}

	const requestId = ++captureRequestId;
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			captureWaiters.delete(requestId);
			reject(new Error('Encoder tap did not acknowledge its capture state.'));
		}, CAPTURE_TIMEOUT_MS);
		captureWaiters.set(requestId, { resolve, reject, timeout });
		capturePort?.postMessage({ type: 'capture', active, requestId });
	});
}

function resolveCaptureRequest(requestId: number): void {
	const waiter = captureWaiters.get(requestId);
	if (!waiter) {
		return;
	}
	clearTimeout(waiter.timeout);
	captureWaiters.delete(requestId);
	waiter.resolve();
}

function assertInitialized(action: string): void {
	if (failed) {
		throw new Error(`Encoder source worker cannot ${action} after the source bridge failed.`);
	}
	if (!mode || !capturePort || !socket || socket.readyState !== WebSocket.OPEN) {
		throw new Error(`Encoder source worker cannot ${action} before initialization.`);
	}
}

function openSocket(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const nextSocket = new WebSocket(url);
		nextSocket.binaryType = 'arraybuffer';
		const timeout = setTimeout(() => {
			cleanup();
			nextSocket.close();
			reject(new Error('Source bridge timed out.'));
		}, 5000);
		const cleanup = () => {
			clearTimeout(timeout);
			nextSocket.removeEventListener('open', handleOpen);
			nextSocket.removeEventListener('error', handleError);
		};
		const handleOpen = () => {
			cleanup();
			resolve(nextSocket);
		};
		const handleError = () => {
			cleanup();
			reject(new Error('Could not open source bridge.'));
		};
		nextSocket.addEventListener('open', handleOpen);
		nextSocket.addEventListener('error', handleError);
	});
}

function handleSocketClose(): void {
	failSource('Source bridge connection closed unexpectedly.');
}

function handleSocketError(): void {
	failSource('Source bridge connection failed.');
}

function failSource(message: string): void {
	if (stopping || failed) {
		return;
	}
	failed = true;
	encoder = null;
	post({ type: 'source-state', connected: false });
	post({ type: 'error', message });
	void setCaptureActive(false).catch(() => undefined);

	if (socket?.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify({ type: mode === 'talk' ? 'end' : 'stop' }));
	}
	if (socket && socket.readyState < WebSocket.CLOSING) {
		socket.close();
	}
}

function respond(requestId: number, ok: boolean, error?: string): void {
	post(ok ? { type: 'response', requestId, ok: true } : { type: 'response', requestId, ok: false, error: error ?? 'Unknown worker error.' });
}

function post(message: WorkerResponse): void {
	workerScope.postMessage(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Encoder source worker failed.';
}
