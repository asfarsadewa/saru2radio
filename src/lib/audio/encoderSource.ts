const PROCESSOR_NAME = 'saru2radio-encoder-tap';
const COMMAND_TIMEOUT_MS = 10_000;

export type EncoderSourceMode = 'source' | 'talk';

type EncoderSourceOptions = {
	mode: EncoderSourceMode;
	bitrateKbps: number;
	socketUrl: string;
	onError(message: string): void;
	onSourceState(connected: boolean): void;
};

type WorkerMessage =
	| { type: 'response'; requestId: number; ok: true }
	| { type: 'response'; requestId: number; ok: false; error: string }
	| { type: 'source-state'; connected: boolean }
	| { type: 'error'; message: string };

type PendingCommand = {
	resolve(): void;
	reject(error: Error): void;
	timeout: number;
};

export class EncoderSourceBridge {
	private nextRequestId = 0;
	private pending = new Map<number, PendingCommand>();
	private disposed = false;
	private stopping = false;

	private constructor(
		private readonly node: AudioWorkletNode,
		private readonly worker: Worker,
		private readonly options: EncoderSourceOptions
	) {
		this.worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => this.handleWorkerMessage(event.data));
		this.worker.addEventListener('error', () => this.handleFatalError('Encoder source worker crashed.'));
		this.worker.addEventListener('messageerror', () => this.handleFatalError('Encoder source worker sent unreadable data.'));
		this.node.onprocessorerror = () => this.handleFatalError('Audio encoder tap stopped processing.');
	}

	static async connect(context: AudioContext, input: AudioNode, options: EncoderSourceOptions): Promise<EncoderSourceBridge> {
		if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined' || typeof Worker === 'undefined') {
			throw new Error('This browser does not support the real-time audio worklet required for broadcasting.');
		}

		await context.audioWorklet.addModule(new URL('./encoderTapWorklet.js', import.meta.url).href);
		const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [1],
			channelCount: 1,
			channelCountMode: 'explicit'
		});
		const worker = new Worker(new URL('./encoderSourceWorker.ts', import.meta.url), {
			type: 'module',
			name: 'saru2radio-encoder-source'
		});
		const bridge = new EncoderSourceBridge(node, worker, options);
		const channel = new MessageChannel();

		node.port.postMessage({ type: 'attach', port: channel.port1 }, [channel.port1]);
		input.connect(node);
		node.connect(context.destination);

		try {
			await bridge.command(
				'initialize',
				{
					mode: options.mode,
					sampleRate: context.sampleRate,
					bitrateKbps: options.bitrateKbps,
					socketUrl: options.socketUrl,
					port: channel.port2
				},
				[channel.port2]
			);
			return bridge;
		} catch (error) {
			bridge.dispose();
			throw error;
		}
	}

	beginTalk(): Promise<void> {
		return this.command('begin-talk');
	}

	endTalk(): Promise<void> {
		return this.command('end-talk');
	}

	async stop(): Promise<void> {
		if (this.disposed || this.stopping) {
			return;
		}
		this.stopping = true;
		try {
			await this.command('stop');
		} finally {
			this.dispose();
		}
	}

	private command(
		type: 'initialize' | 'begin-talk' | 'end-talk' | 'stop',
		payload: Record<string, unknown> = {},
		transfer: Transferable[] = []
	): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new Error('Encoder source bridge is already closed.'));
		}

		const requestId = ++this.nextRequestId;
		return new Promise<void>((resolve, reject) => {
			const timeout = window.setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error(`Encoder source command timed out: ${type}.`));
			}, COMMAND_TIMEOUT_MS);
			this.pending.set(requestId, { resolve, reject, timeout });
			this.worker.postMessage({ type, requestId, ...payload }, transfer);
		});
	}

	private handleWorkerMessage(message: WorkerMessage): void {
		if (message.type === 'response') {
			const pending = this.pending.get(message.requestId);
			if (!pending) {
				return;
			}
			window.clearTimeout(pending.timeout);
			this.pending.delete(message.requestId);
			if (message.ok) {
				pending.resolve();
			} else {
				pending.reject(new Error(message.error));
			}
			return;
		}

		if (message.type === 'source-state') {
			this.options.onSourceState(message.connected);
			return;
		}

		this.options.onError(message.message);
	}

	private handleFatalError(message: string): void {
		if (this.disposed) {
			return;
		}
		this.options.onError(message);
		this.options.onSourceState(false);
		for (const pending of this.pending.values()) {
			window.clearTimeout(pending.timeout);
			pending.reject(new Error(message));
		}
		this.pending.clear();
		this.dispose();
	}

	private dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const pending of this.pending.values()) {
			window.clearTimeout(pending.timeout);
			pending.reject(new Error('Encoder source bridge closed.'));
		}
		this.pending.clear();
		this.node.onprocessorerror = null;
		this.node.port.close();
		this.node.disconnect();
		this.worker.terminate();
	}
}
