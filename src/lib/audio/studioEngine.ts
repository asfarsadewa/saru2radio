import { LiveMp3Encoder, TARGET_SAMPLE_RATE } from './liveMp3';
import type { Track } from '../types';

type EngineCallbacks = {
	onTrack(track: Track): void;
	onLevel(level: number): void;
	onError(message: string): void;
	onSourceState(connected: boolean): void;
};

type EngineOptions = {
	bitrateKbps: number;
	musicVolume: number;
	micVolume: number;
	duckingDb: number;
	monitor: boolean;
};

export class StudioEngine {
	private context: AudioContext | null = null;
	private socket: WebSocket | null = null;
	private encoder: LiveMp3Encoder | null = null;
	private processor: ScriptProcessorNode | null = null;
	private analyser: AnalyserNode | null = null;
	private analyserData: Uint8Array<ArrayBuffer> | null = null;
	private levelFrame = 0;
	private musicGain: GainNode | null = null;
	private micGain: GainNode | null = null;
	private monitorGain: GainNode | null = null;
	private currentSource: AudioBufferSourceNode | null = null;
	private currentQueue: Track[] = [];
	private currentIndex = 0;
	private callbacks: EngineCallbacks | null = null;
	private options: EngineOptions | null = null;
	private running = false;
	private micOpen = false;
	private skipRequested = false;

	async start(queue: Track[], options: EngineOptions, callbacks: EngineCallbacks) {
		if (this.running) {
			await this.stop();
		}

		if (queue.length === 0) {
			throw new Error('Prepare at least one track before going on air.');
		}

		this.callbacks = callbacks;
		this.options = options;
		this.currentQueue = queue;
		this.currentIndex = 0;
		this.running = true;

		const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
		if (!AudioContextConstructor) {
			throw new Error('Web Audio is not available in this browser.');
		}

		this.context = createAudioContext(AudioContextConstructor);
		if (this.context.state === 'suspended') {
			await this.context.resume();
		}

		this.encoder = new LiveMp3Encoder(this.context.sampleRate, options.bitrateKbps);
		this.socket = await openSourceSocket(options.bitrateKbps);
		this.callbacks.onSourceState(true);
		this.socket.addEventListener('close', () => this.callbacks?.onSourceState(false));
		this.socket.addEventListener('error', () => this.callbacks?.onError('Source bridge connection failed.'));

		const limiter = this.context.createDynamicsCompressor();
		limiter.threshold.value = -6;
		limiter.knee.value = 8;
		limiter.ratio.value = 12;
		limiter.attack.value = 0.003;
		limiter.release.value = 0.12;

		this.musicGain = this.context.createGain();
		this.musicGain.gain.value = options.musicVolume;
		this.musicGain.connect(limiter);

		this.micGain = this.context.createGain();
		this.micGain.gain.value = 0;
		this.micGain.connect(limiter);

		await this.attachMicrophone();

		this.analyser = this.context.createAnalyser();
		this.analyser.fftSize = 512;
		this.analyser.smoothingTimeConstant = 0.5;
		this.analyserData = new Uint8Array(this.analyser.fftSize);
		limiter.connect(this.analyser);

		this.processor = this.context.createScriptProcessor(8192, 1, 1);
		this.processor.onaudioprocess = (event) => {
			const input = event.inputBuffer.getChannelData(0);
			const output = event.outputBuffer.getChannelData(0);
			output.fill(0);
			this.sendEncoded(input);
		};
		limiter.connect(this.processor);
		this.processor.connect(this.context.destination);

		this.monitorGain = this.context.createGain();
		this.monitorGain.gain.value = options.monitor ? 1 : 0;
		limiter.connect(this.monitorGain);
		this.monitorGain.connect(this.context.destination);

		this.updateLevel();
		await this.playCurrentTrack();
	}

	async stop() {
		this.running = false;
		this.skipRequested = false;
		this.currentSource?.stop();
		this.currentSource = null;

		if (this.encoder && this.socket?.readyState === WebSocket.OPEN) {
			for (const chunk of this.encoder.flush()) {
				this.socket.send(chunk);
			}
			this.socket.send(JSON.stringify({ type: 'stop' }));
		}

		this.socket?.close();
		this.socket = null;
		this.encoder = null;

		if (this.levelFrame) {
			cancelAnimationFrame(this.levelFrame);
			this.levelFrame = 0;
		}

		this.processor?.disconnect();
		this.analyser?.disconnect();
		this.musicGain?.disconnect();
		this.micGain?.disconnect();
		this.monitorGain?.disconnect();
		this.processor = null;
		this.analyser = null;
		this.musicGain = null;
		this.micGain = null;
		this.monitorGain = null;

		if (this.context && this.context.state !== 'closed') {
			await this.context.close();
		}
		this.context = null;
		this.callbacks?.onSourceState(false);
	}

	skip() {
		this.skipRequested = true;
		this.currentSource?.stop();
	}

	setMicOpen(open: boolean) {
		this.micOpen = open;
		this.applyDucking();
	}

	setOptions(options: Partial<EngineOptions>) {
		if (!this.options || !this.context) {
			return;
		}

		this.options = { ...this.options, ...options };
		this.monitorGain?.gain.setTargetAtTime(this.options.monitor ? 1 : 0, this.context.currentTime, 0.03);
		this.applyDucking();
	}

	private async attachMicrophone() {
		if (!this.context || !this.micGain) {
			return;
		}

		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: false,
					noiseSuppression: false,
					autoGainControl: false
				}
			});
			const source = this.context.createMediaStreamSource(stream);
			const highPass = this.context.createBiquadFilter();
			highPass.type = 'highpass';
			highPass.frequency.value = 100;
			const compressor = this.context.createDynamicsCompressor();
			compressor.threshold.value = -24;
			compressor.knee.value = 18;
			compressor.ratio.value = 4;
			compressor.attack.value = 0.006;
			compressor.release.value = 0.18;
			source.connect(highPass);
			highPass.connect(compressor);
			compressor.connect(this.micGain);
		} catch {
			this.callbacks?.onError('Microphone is unavailable; music streaming can continue.');
		}
	}

	private async playCurrentTrack() {
		if (!this.running || !this.context || !this.musicGain) {
			return;
		}

		const track = this.currentQueue[this.currentIndex % this.currentQueue.length];
		if (!track) {
			return;
		}

		this.callbacks?.onTrack(track);
		const response = await fetch(`/api/tracks/${track.id}/cache`);
		if (!response.ok) {
			throw new Error(`Could not load cached track: ${track.fileName}`);
		}

		const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
		const source = this.context.createBufferSource();
		source.buffer = buffer;
		source.connect(this.musicGain);
		source.onended = () => {
			if (!this.running) {
				return;
			}

			const advanceBy = this.skipRequested ? 1 : 1;
			this.skipRequested = false;
			this.currentIndex = (this.currentIndex + advanceBy) % this.currentQueue.length;
			void this.playCurrentTrack().catch((error) => this.callbacks?.onError(error.message));
		};
		this.currentSource = source;
		source.start();
	}

	private sendEncoded(input: Float32Array) {
		if (!this.encoder || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
			return;
		}

		for (const chunk of this.encoder.encode(input)) {
			this.socket.send(chunk);
		}
	}

	private applyDucking() {
		if (!this.context || !this.options) {
			return;
		}

		const now = this.context.currentTime;
		const musicTarget = this.micOpen
			? this.options.musicVolume * 10 ** (this.options.duckingDb / 20)
			: this.options.musicVolume;
		const micTarget = this.micOpen ? this.options.micVolume : 0;
		this.musicGain?.gain.setTargetAtTime(musicTarget, now, this.micOpen ? 0.05 : 0.18);
		this.micGain?.gain.setTargetAtTime(micTarget, now, this.micOpen ? 0.02 : 0.1);
	}

	private updateLevel() {
		if (!this.analyser || !this.analyserData) {
			return;
		}

		this.analyser.getByteTimeDomainData(this.analyserData);
		let sum = 0;
		for (const value of this.analyserData) {
			const normalized = (value - 128) / 128;
			sum += normalized * normalized;
		}
		const rms = Math.sqrt(sum / this.analyserData.length);
		this.callbacks?.onLevel(Math.min(1, Math.max(0.04, Math.pow(rms * 8, 0.7))));
		this.levelFrame = requestAnimationFrame(() => this.updateLevel());
	}
}

async function openSourceSocket(bitrateKbps: number): Promise<WebSocket> {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const socket = new WebSocket(`${protocol}//${window.location.host}/source`);
	socket.binaryType = 'arraybuffer';

	await new Promise<void>((resolve, reject) => {
		const timeout = window.setTimeout(() => reject(new Error('Source bridge timed out.')), 5000);
		socket.addEventListener(
			'open',
			() => {
				window.clearTimeout(timeout);
				socket.send(JSON.stringify({ type: 'start', bitrateKbps }));
				resolve();
			},
			{ once: true }
		);
		socket.addEventListener(
			'error',
			() => {
				window.clearTimeout(timeout);
				reject(new Error('Could not open source bridge.'));
			},
			{ once: true }
		);
	});

	return socket;
}

declare global {
	interface Window {
		webkitAudioContext?: typeof AudioContext;
	}
}

function createAudioContext(AudioContextConstructor: typeof AudioContext): AudioContext {
	try {
		return new AudioContextConstructor({
			latencyHint: 'playback',
			sampleRate: TARGET_SAMPLE_RATE
		});
	} catch {
		return new AudioContextConstructor({ latencyHint: 'playback' });
	}
}
