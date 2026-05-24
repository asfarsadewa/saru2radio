import { LiveMp3Encoder, TARGET_SAMPLE_RATE } from './liveMp3';
import type { Track } from '../types';

const MIXER_BUFFER_SIZE = 4096;

type EngineCallbacks = {
	onTrack(track: Track): void;
	onLevel(level: number): void;
	onMicLevel(level: number): void;
	onMicState(state: MicCaptureState): void;
	onError(message: string): void;
	onSourceState(connected: boolean): void;
};

type EngineOptions = {
	bitrateKbps: number;
	musicVolume: number;
	micVolume: number;
	micDeviceId: string;
	micColor: MicColorMode;
	duckingDb: number;
	monitor: boolean;
};

export type MicColorMode = 'clean' | 'broadcast' | 'shortwave';

export type MicCaptureState = {
	connected: boolean;
	label: string;
	muted: boolean;
	message: string | null;
};

type MicAudioGraph = {
	stream: MediaStream;
	source: MediaStreamAudioSourceNode;
	splitter: ChannelSplitterNode;
	left: GainNode;
	right: GainNode;
	mono: GainNode;
	highPass: BiquadFilterNode;
	preamp: GainNode;
	compressor: DynamicsCompressorNode;
	lowPass: BiquadFilterNode;
	shaper: WaveShaperNode;
	makeup: GainNode;
	analyser: AnalyserNode;
	analyserData: Uint8Array<ArrayBuffer>;
	meterTap: GainNode;
	noiseSource: AudioBufferSourceNode;
	noiseFilter: BiquadFilterNode;
	noiseGain: GainNode;
};

type MicColorSettings = {
	highPassHz: number;
	lowPassHz: number;
	preamp: number;
	makeup: number;
	compressorThreshold: number;
	compressorRatio: number;
	compressorAttack: number;
	compressorRelease: number;
	drive: number;
	noiseGain: number;
};

const MIC_COLOR_SETTINGS: Record<MicColorMode, MicColorSettings> = {
	clean: {
		highPassHz: 100,
		lowPassHz: 9500,
		preamp: 2.2,
		makeup: 1.25,
		compressorThreshold: -26,
		compressorRatio: 4,
		compressorAttack: 0.006,
		compressorRelease: 0.18,
		drive: 0,
		noiseGain: 0
	},
	broadcast: {
		highPassHz: 145,
		lowPassHz: 4550,
		preamp: 2.5,
		makeup: 1.65,
		compressorThreshold: -30,
		compressorRatio: 5.5,
		compressorAttack: 0.004,
		compressorRelease: 0.2,
		drive: 1.1,
		noiseGain: 0.0015
	},
	shortwave: {
		highPassHz: 260,
		lowPassHz: 3150,
		preamp: 3,
		makeup: 1.5,
		compressorThreshold: -34,
		compressorRatio: 8,
		compressorAttack: 0.003,
		compressorRelease: 0.24,
		drive: 2.4,
		noiseGain: 0.008
	}
};
const MIC_METER_FLOOR = 0.008;
const MIC_METER_CEILING = 0.16;
const EMPTY_MIC_STATE: MicCaptureState = {
	connected: false,
	label: '',
	muted: false,
	message: null
};

export class StudioEngine {
	private context: AudioContext | null = null;
	private socket: WebSocket | null = null;
	private encoder: LiveMp3Encoder | null = null;
	private processor: ScriptProcessorNode | null = null;
	private analyser: AnalyserNode | null = null;
	private analyserData: Uint8Array<ArrayBuffer> | null = null;
	private levelFrame = 0;
	private micLevelFrame = 0;
	private musicGain: GainNode | null = null;
	private micGain: GainNode | null = null;
	private micGraph: MicAudioGraph | null = null;
	private monitorGain: GainNode | null = null;
	private currentSource: AudioBufferSourceNode | null = null;
	private currentQueue: Track[] = [];
	private currentIndex = 0;
	private sourceToken = 0;
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
		this.micOpen = false;

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

		this.processor = this.context.createScriptProcessor(MIXER_BUFFER_SIZE, 1, 1);
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
		this.micOpen = false;
		this.skipRequested = false;
		this.sourceToken += 1;
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
		if (this.micLevelFrame) {
			cancelAnimationFrame(this.micLevelFrame);
			this.micLevelFrame = 0;
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
		this.detachMicrophone();

		if (this.context && this.context.state !== 'closed') {
			await this.context.close();
		}
		this.context = null;
		this.callbacks?.onMicLevel(0);
		this.callbacks?.onSourceState(false);
	}

	skip() {
		this.skipRequested = true;
		this.currentSource?.stop();
	}

	async playNow(track: Track) {
		if (!this.running) {
			this.currentQueue = [track, ...this.currentQueue.filter((queued) => queued.id !== track.id)];
			this.currentIndex = 0;
			return;
		}

		this.currentQueue = [track, ...this.currentQueue.filter((queued) => queued.id !== track.id)];
		this.currentIndex = 0;
		this.skipRequested = false;
		const previous = this.currentSource;
		this.currentSource = null;
		this.sourceToken += 1;
		previous?.stop();
		await this.playCurrentTrack();
	}

	setQueue(queue: Track[]) {
		if (queue.length === 0) {
			return;
		}

		const current = this.currentQueue[this.currentIndex % this.currentQueue.length];
		this.currentQueue = queue;
		const currentIndex = current ? queue.findIndex((track) => track.id === current.id) : -1;
		this.currentIndex = currentIndex >= 0 ? currentIndex : 0;
	}

	setMicOpen(open: boolean) {
		this.micOpen = open;
		if (open && !this.micGraph) {
			this.callbacks?.onError('Microphone is not connected; check browser mic permission and input device.');
		}
		this.applyDucking();
	}

	setOptions(options: Partial<EngineOptions>) {
		if (!this.options || !this.context) {
			return;
		}

		this.options = { ...this.options, ...options };
		if (this.micGraph && options.micColor) {
			configureMicColor(this.micGraph, options.micColor);
		}
		this.monitorGain?.gain.setTargetAtTime(this.options.monitor ? 1 : 0, this.context.currentTime, 0.03);
		this.applyDucking();
	}

	async selectMicrophone(deviceId: string) {
		if (!this.options) {
			return;
		}

		this.options = { ...this.options, micDeviceId: deviceId };
		if (!this.context || !this.micGain) {
			return;
		}

		await this.attachMicrophone();
		this.applyDucking();
	}

	async retryMicrophone() {
		if (!this.context || !this.micGain) {
			return;
		}

		await this.attachMicrophone();
		this.applyDucking();
	}

	private async attachMicrophone() {
		if (!this.context || !this.micGain) {
			return;
		}

		this.detachMicrophone();
		this.callbacks?.onMicState({
			...EMPTY_MIC_STATE,
			message: 'Requesting microphone access.'
		});

		let stream: MediaStream | null = null;
		try {
			if (!navigator.mediaDevices?.getUserMedia) {
				throw new Error('Browser microphone capture is unavailable on this page.');
			}

			stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(this.options?.micDeviceId ?? ''));
			const [track] = stream.getAudioTracks();
			if (!track) {
				throw new Error('No audio track was returned by the browser.');
			}
			const source = this.context.createMediaStreamSource(stream);
			const splitter = this.context.createChannelSplitter(2);
			const left = this.context.createGain();
			const right = this.context.createGain();
			const mono = this.context.createGain();
			const highPass = this.context.createBiquadFilter();
			highPass.type = 'highpass';
			const preamp = this.context.createGain();
			const compressor = this.context.createDynamicsCompressor();
			compressor.knee.value = 18;
			const lowPass = this.context.createBiquadFilter();
			lowPass.type = 'lowpass';
			const shaper = this.context.createWaveShaper();
			shaper.oversample = '2x';
			const makeup = this.context.createGain();
			const analyser = this.context.createAnalyser();
			analyser.fftSize = 512;
			analyser.smoothingTimeConstant = 0.45;
			const analyserData = new Uint8Array(analyser.fftSize);
			const meterTap = this.context.createGain();
			meterTap.gain.value = 0;
			const noiseSource = createNoiseSource(this.context);
			const noiseFilter = this.context.createBiquadFilter();
			noiseFilter.type = 'bandpass';
			noiseFilter.frequency.value = 2500;
			noiseFilter.Q.value = 0.8;
			const noiseGain = this.context.createGain();
			noiseGain.gain.value = 0;
			source.connect(splitter);
			splitter.connect(left, 0);
			splitter.connect(right, 1);
			left.connect(mono);
			right.connect(mono);
			mono.connect(highPass);
			highPass.connect(preamp);
			preamp.connect(compressor);
			compressor.connect(lowPass);
			lowPass.connect(shaper);
			shaper.connect(makeup);
			highPass.connect(analyser);
			makeup.connect(meterTap);
			meterTap.connect(this.context.destination);
			makeup.connect(this.micGain);
			noiseSource.connect(noiseFilter);
			noiseFilter.connect(noiseGain);
			noiseGain.connect(this.micGain);
			this.micGraph = {
				stream,
				source,
				splitter,
				left,
				right,
				mono,
				highPass,
				preamp,
				compressor,
				lowPass,
				shaper,
				makeup,
				analyser,
				analyserData,
				meterTap,
				noiseSource,
				noiseFilter,
				noiseGain
			};
			configureMicColor(this.micGraph, this.options?.micColor ?? 'broadcast');
			noiseSource.start();
			const label = track.label || 'Default microphone';
			const channelCount = track.getSettings().channelCount;
			track.addEventListener('mute', () => {
				if (this.micGraph?.stream === stream) {
					this.callbacks?.onMicState({
						connected: true,
						label,
						muted: true,
						message: 'The selected microphone is muted by the browser or operating system.'
					});
				}
			});
			track.addEventListener('unmute', () => {
				if (this.micGraph?.stream === stream) {
					this.callbacks?.onMicState({
						connected: true,
						label,
						muted: false,
						message: null
					});
				}
			});
			track.addEventListener('ended', () => {
				if (this.micGraph?.stream === stream) {
					this.detachMicrophone();
					this.applyDucking();
					this.callbacks?.onMicState({
						...EMPTY_MIC_STATE,
						message: 'Microphone capture ended. Choose an input or retry the mic.'
					});
				}
			});
			this.callbacks?.onMicState({
				connected: true,
				label,
				muted: track.muted,
				message: track.muted
					? 'The selected microphone is muted by the browser or operating system.'
					: channelCount && channelCount > 1
						? `Capturing ${channelCount} input channels and summing them to mono.`
						: null
			});
			this.updateMicLevel();
		} catch (error) {
			for (const track of stream?.getTracks() ?? []) {
				track.stop();
			}
			this.detachMicrophone();
			const message = error instanceof Error ? error.message : 'Microphone is unavailable.';
			this.callbacks?.onMicState({
				...EMPTY_MIC_STATE,
				message
			});
			this.callbacks?.onError(`${message} Music streaming can continue.`);
		}
	}

	private detachMicrophone() {
		if (!this.micGraph) {
			return;
		}

		if (this.micLevelFrame) {
			cancelAnimationFrame(this.micLevelFrame);
			this.micLevelFrame = 0;
		}
		this.micGraph.source.disconnect();
		this.micGraph.splitter.disconnect();
		this.micGraph.left.disconnect();
		this.micGraph.right.disconnect();
		this.micGraph.mono.disconnect();
		this.micGraph.highPass.disconnect();
		this.micGraph.preamp.disconnect();
		this.micGraph.compressor.disconnect();
		this.micGraph.lowPass.disconnect();
		this.micGraph.shaper.disconnect();
		this.micGraph.makeup.disconnect();
		this.micGraph.analyser.disconnect();
		this.micGraph.meterTap.disconnect();
		this.micGraph.noiseSource.disconnect();
		this.micGraph.noiseFilter.disconnect();
		this.micGraph.noiseGain.disconnect();
		try {
			this.micGraph.noiseSource.stop();
		} catch {
			// The noise source may already have ended during teardown.
		}
		for (const track of this.micGraph.stream.getTracks()) {
			track.stop();
		}
		this.micGraph = null;
		this.callbacks?.onMicState(EMPTY_MIC_STATE);
		this.callbacks?.onMicLevel(0);
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
		const sourceToken = (this.sourceToken += 1);
		source.buffer = buffer;
		source.connect(this.musicGain);
		source.onended = () => {
			if (!this.running || sourceToken !== this.sourceToken || this.currentSource !== source) {
				return;
			}

			const advanceBy = this.skipRequested ? 1 : 1;
			this.skipRequested = false;
			this.currentIndex = (this.currentIndex + advanceBy) % this.currentQueue.length;
			this.currentSource = null;
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

		const effectiveMicOpen = this.micOpen && Boolean(this.micGraph);
		const now = this.context.currentTime;
		const musicTarget = effectiveMicOpen
			? this.options.musicVolume * 10 ** (this.options.duckingDb / 20)
			: this.options.musicVolume;
		const micTarget = effectiveMicOpen ? this.options.micVolume : 0;
		this.musicGain?.gain.setTargetAtTime(musicTarget, now, effectiveMicOpen ? 0.05 : 0.18);
		this.micGain?.gain.setTargetAtTime(micTarget, now, effectiveMicOpen ? 0.02 : 0.1);
	}

	private updateMicLevel() {
		if (!this.micGraph) {
			return;
		}

		const { analyser, analyserData } = this.micGraph;
		analyser.getByteTimeDomainData(analyserData);
		let sum = 0;
		for (const value of analyserData) {
			const normalized = (value - 128) / 128;
			sum += normalized * normalized;
		}
		const rms = Math.sqrt(sum / analyserData.length);
		const level = (rms - MIC_METER_FLOOR) / (MIC_METER_CEILING - MIC_METER_FLOOR);
		this.callbacks?.onMicLevel(Math.min(1, Math.max(0, Math.pow(level, 0.75))));
		this.micLevelFrame = requestAnimationFrame(() => this.updateMicLevel());
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

function buildMicConstraints(deviceId: string): MediaStreamConstraints {
	return {
		audio: {
			deviceId: deviceId ? { exact: deviceId } : undefined,
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
			channelCount: { ideal: 2 }
		}
	};
}

function configureMicColor(graph: MicAudioGraph, mode: MicColorMode) {
	const settings = MIC_COLOR_SETTINGS[mode];
	graph.highPass.frequency.setTargetAtTime(settings.highPassHz, graph.highPass.context.currentTime, 0.015);
	graph.lowPass.frequency.setTargetAtTime(settings.lowPassHz, graph.lowPass.context.currentTime, 0.015);
	graph.preamp.gain.setTargetAtTime(settings.preamp, graph.preamp.context.currentTime, 0.015);
	graph.makeup.gain.setTargetAtTime(settings.makeup, graph.makeup.context.currentTime, 0.015);
	graph.compressor.threshold.value = settings.compressorThreshold;
	graph.compressor.ratio.value = settings.compressorRatio;
	graph.compressor.attack.value = settings.compressorAttack;
	graph.compressor.release.value = settings.compressorRelease;
	graph.shaper.curve = makeSoftClipCurve(settings.drive);
	graph.noiseGain.gain.setTargetAtTime(settings.noiseGain, graph.noiseGain.context.currentTime, 0.03);
}

function makeSoftClipCurve(drive: number): Float32Array<ArrayBuffer> {
	const samples = 1024;
	const curve = new Float32Array(new ArrayBuffer(samples * Float32Array.BYTES_PER_ELEMENT));
	const amount = Math.max(0, drive);
	for (let index = 0; index < samples; index += 1) {
		const x = (index / (samples - 1)) * 2 - 1;
		curve[index] = amount === 0 ? x : ((1 + amount) * x) / (1 + amount * Math.abs(x));
	}
	return curve;
}

function createNoiseSource(context: AudioContext): AudioBufferSourceNode {
	const length = context.sampleRate * 2;
	const buffer = context.createBuffer(1, length, context.sampleRate);
	const data = buffer.getChannelData(0);
	for (let index = 0; index < data.length; index += 1) {
		data[index] = Math.random() * 2 - 1;
	}

	const source = context.createBufferSource();
	source.buffer = buffer;
	source.loop = true;
	return source;
}
