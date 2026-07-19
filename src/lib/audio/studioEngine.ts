import { rmsTimeDomainLevel } from './level';
import { EncoderSourceBridge, type EncoderSourceMode } from './encoderSource';
import { TARGET_SAMPLE_RATE } from './audioConstants';
import type { Track } from '../types';

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
	ambientBedEnabled: boolean;
	ambientBedLevel: number;
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
const VOICE_AMBIENT_MAX_GAIN = 0.025;
const EMPTY_MIC_STATE: MicCaptureState = {
	connected: false,
	label: '',
	muted: false,
	message: null
};

export class StudioEngine {
	private context: AudioContext | null = null;
	private encoderSource: EncoderSourceBridge | null = null;
	private encoderSessionToken = 0;
	private analyser: AnalyserNode | null = null;
	private analyserData: Uint8Array<ArrayBuffer> | null = null;
	private levelFrame = 0;
	private micLevelFrame = 0;
	private musicGain: GainNode | null = null;
	private micGain: GainNode | null = null;
	private micGraph: MicAudioGraph | null = null;
	private monitorGain: GainNode | null = null;
	private ambientSource: AudioBufferSourceNode | null = null;
	private ambientFilter: BiquadFilterNode | null = null;
	private ambientGain: GainNode | null = null;
	private currentSource: AudioBufferSourceNode | null = null;
	private currentQueue: Track[] = [];
	private currentIndex = 0;
	private sourceToken = 0;
	private callbacks: EngineCallbacks | null = null;
	private options: EngineOptions | null = null;
	private running = false;
	private micOpen = false;
	private mode: 'mixer' | 'talk' | 'voice' | null = null;
	private talkActive = false;
	private talkTransition: Promise<void> = Promise.resolve();
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
		this.mode = 'mixer';
		this.talkActive = false;

		const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
		if (!AudioContextConstructor) {
			throw new Error('Web Audio is not available in this browser.');
		}

		this.context = createAudioContext(AudioContextConstructor);
		await this.ensureContextRunning();

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

		await this.connectEncoderSource(limiter, 'source', 'DJ mixer source bridge');

		this.monitorGain = this.context.createGain();
		this.monitorGain.gain.value = options.monitor ? 1 : 0;
		limiter.connect(this.monitorGain);
		this.monitorGain.connect(this.context.destination);

		this.updateLevel();
		await this.playCurrentTrack();
	}

	async startVoiceProgram(options: EngineOptions, callbacks: EngineCallbacks) {
		if (this.running) {
			await this.stop();
		}

		this.callbacks = callbacks;
		this.options = options;
		this.currentQueue = [];
		this.currentIndex = 0;
		this.running = true;
		this.micOpen = false;
		this.mode = 'voice';
		this.talkActive = false;

		const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
		if (!AudioContextConstructor) {
			throw new Error('Web Audio is not available in this browser.');
		}

		try {
			this.context = createAudioContext(AudioContextConstructor);
			await this.ensureContextRunning();

			const limiter = this.context.createDynamicsCompressor();
			limiter.threshold.value = -8;
			limiter.knee.value = 10;
			limiter.ratio.value = 10;
			limiter.attack.value = 0.003;
			limiter.release.value = 0.16;

			this.micGain = this.context.createGain();
			this.micGain.gain.value = 0;
			this.micGain.connect(limiter);

			this.ambientSource = createNoiseSource(this.context);
			this.ambientFilter = this.context.createBiquadFilter();
			this.ambientFilter.type = 'bandpass';
			this.ambientFilter.frequency.value = 900;
			this.ambientFilter.Q.value = 0.45;
			this.ambientGain = this.context.createGain();
			this.ambientGain.gain.value = ambientBedGain(options);
			this.ambientSource.connect(this.ambientFilter);
			this.ambientFilter.connect(this.ambientGain);
			this.ambientGain.connect(limiter);
			this.ambientSource.start();

			await this.attachMicrophone({ throwOnFailure: true });
			if (!this.micGraph) {
				throw new Error('Microphone is unavailable.');
			}

			this.analyser = this.context.createAnalyser();
			this.analyser.fftSize = 512;
			this.analyser.smoothingTimeConstant = 0.5;
			this.analyserData = new Uint8Array(this.analyser.fftSize);
			limiter.connect(this.analyser);

			await this.connectEncoderSource(limiter, 'source', 'Voice program source bridge');

			this.monitorGain = this.context.createGain();
			this.monitorGain.gain.value = options.monitor ? 1 : 0;
			limiter.connect(this.monitorGain);
			this.monitorGain.connect(this.context.destination);

			this.updateLevel();
			this.applyDucking();
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async startTalkBreak(options: EngineOptions, callbacks: EngineCallbacks) {
		if (this.running) {
			await this.stop();
		}

		this.callbacks = callbacks;
		this.options = options;
		this.currentQueue = [];
		this.currentIndex = 0;
		this.running = true;
		this.micOpen = false;
		this.mode = 'talk';
		this.talkActive = false;

		const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
		if (!AudioContextConstructor) {
			throw new Error('Web Audio is not available in this browser.');
		}

		this.context = createAudioContext(AudioContextConstructor);
		await this.ensureContextRunning();

		const limiter = this.context.createDynamicsCompressor();
		limiter.threshold.value = -8;
		limiter.knee.value = 10;
		limiter.ratio.value = 10;
		limiter.attack.value = 0.003;
		limiter.release.value = 0.14;

		this.micGain = this.context.createGain();
		this.micGain.gain.value = 0;
		this.micGain.connect(limiter);

		await this.attachMicrophone();

		this.analyser = this.context.createAnalyser();
		this.analyser.fftSize = 512;
		this.analyser.smoothingTimeConstant = 0.5;
		this.analyserData = new Uint8Array(this.analyser.fftSize);
		limiter.connect(this.analyser);

		await this.connectEncoderSource(limiter, 'talk', 'Talk break bridge');

		this.monitorGain = this.context.createGain();
		this.monitorGain.gain.value = options.monitor ? 1 : 0;
		limiter.connect(this.monitorGain);
		this.monitorGain.connect(this.context.destination);

		this.updateLevel();
	}

	async stop() {
		const mode = this.mode;
		this.running = false;
		this.micOpen = false;
		this.skipRequested = false;
		this.sourceToken += 1;
		this.currentSource?.stop();
		this.currentSource = null;
		this.talkActive = false;
		const encoderSource = this.encoderSource;
		this.encoderSource = null;
		this.encoderSessionToken += 1;
		try {
			await encoderSource?.stop();
		} catch (error) {
			this.callbacks?.onError(error instanceof Error ? error.message : 'Could not stop the encoder source bridge.');
		}
		this.talkTransition = Promise.resolve();
		this.mode = null;

		if (this.levelFrame) {
			cancelAnimationFrame(this.levelFrame);
			this.levelFrame = 0;
		}
		if (this.micLevelFrame) {
			cancelAnimationFrame(this.micLevelFrame);
			this.micLevelFrame = 0;
		}

		this.analyser?.disconnect();
		this.musicGain?.disconnect();
		this.micGain?.disconnect();
		this.monitorGain?.disconnect();
		this.ambientSource?.disconnect();
		this.ambientFilter?.disconnect();
		this.ambientGain?.disconnect();
		try {
			this.ambientSource?.stop();
		} catch {
			// The ambient bed may already be stopped during teardown.
		}
		this.analyser = null;
		this.musicGain = null;
		this.micGain = null;
		this.monitorGain = null;
		this.ambientSource = null;
		this.ambientFilter = null;
		this.ambientGain = null;
		this.detachMicrophone();

		if (this.context && this.context.state !== 'closed') {
			await this.context.close();
		}
		this.context = null;
		this.callbacks?.onMicLevel(0);
		if (mode === 'mixer' || mode === 'voice') {
			this.callbacks?.onSourceState(false);
		}
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

	async setMicOpen(open: boolean) {
		this.micOpen = open;
		if (open && !this.micGraph) {
			this.callbacks?.onError('Microphone is not ready yet. Allow browser mic access, choose an input, or press Retry mic.');
			return;
		}
		await this.ensureContextRunning();
		if (this.mode === 'talk') {
			this.talkTransition = this.talkTransition.catch(() => undefined).then(() => this.syncTalkCapture());
			await this.talkTransition;
			return;
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
		if (this.ambientGain && (typeof options.ambientBedEnabled === 'boolean' || typeof options.ambientBedLevel === 'number')) {
			this.ambientGain.gain.setTargetAtTime(ambientBedGain(this.options), this.context.currentTime, 0.05);
		}
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

		await this.ensureContextRunning();
		await this.attachMicrophone();
		this.applyDucking();
	}

	async retryMicrophone() {
		if (!this.context || !this.micGain) {
			return;
		}

		await this.ensureContextRunning();
		await this.attachMicrophone();
		this.applyDucking();
	}

	private async ensureContextRunning() {
		if (!this.context || this.context.state === 'closed') {
			return;
		}

		if (this.context.state !== 'running') {
			await this.context.resume();
		}
	}

	private async attachMicrophone(options: { throwOnFailure?: boolean } = {}) {
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
			const message = describeMicError(error);
			this.callbacks?.onMicState({
				...EMPTY_MIC_STATE,
				message
			});
			this.callbacks?.onError(options.throwOnFailure ? message : `${message} Music streaming can continue.`);
			if (options.throwOnFailure) {
				throw new Error(message);
			}
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
		// Claim the token before awaiting: a play-now landing while we fetch and
		// decode must not let this stale continuation start on top of the new one.
		const sourceToken = (this.sourceToken += 1);
		const response = await fetch(`/api/tracks/${track.id}/cache`);
		if (!response.ok) {
			throw new Error(`Could not load cached track: ${track.fileName}`);
		}

		const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
		if (!this.running || !this.context || !this.musicGain || sourceToken !== this.sourceToken) {
			return;
		}

		const source = this.context.createBufferSource();
		source.buffer = buffer;
		source.connect(this.musicGain);
		source.onended = () => {
			if (!this.running || sourceToken !== this.sourceToken || this.currentSource !== source) {
				return;
			}

			this.skipRequested = false;
			this.currentIndex = (this.currentIndex + 1) % this.currentQueue.length;
			this.currentSource = null;
			void this.playCurrentTrack().catch((error) => this.callbacks?.onError(error.message));
		};
		this.currentSource = source;
		source.start();
	}

	private async connectEncoderSource(input: AudioNode, sourceMode: EncoderSourceMode, label: string): Promise<void> {
		if (!this.context || !this.options) {
			throw new Error(`${label} cannot start before the audio graph is ready.`);
		}

		const token = ++this.encoderSessionToken;
		const bridge = await EncoderSourceBridge.connect(this.context, input, {
			mode: sourceMode,
			bitrateKbps: this.options.bitrateKbps,
			socketUrl: studioSocketUrl(sourceMode === 'talk' ? '/talk-break' : '/source'),
			onError: (message) => {
				if (token === this.encoderSessionToken) {
					this.callbacks?.onError(`${label}: ${message}`);
				}
			},
			onSourceState: (connected) => {
				if (sourceMode === 'source' && token === this.encoderSessionToken) {
					this.callbacks?.onSourceState(connected);
				}
			}
		});

		if (!this.running || token !== this.encoderSessionToken) {
			await bridge.stop();
			throw new Error(`${label} was superseded before it finished starting.`);
		}
		this.encoderSource = bridge;
	}

	private async syncTalkCapture(): Promise<void> {
		if (this.mode !== 'talk') {
			return;
		}
		if (this.micOpen && !this.talkActive) {
			await this.beginTalkBreak();
		} else if (!this.micOpen && this.talkActive) {
			await this.finishTalkBreak();
		}
	}

	private async beginTalkBreak(): Promise<void> {
		if (!this.context || !this.options || this.mode !== 'talk' || this.talkActive) {
			return;
		}
		if (!this.micGraph) {
			throw new Error('Microphone is not ready yet. Allow browser mic access, choose an input, or press Retry mic.');
		}
		const bridge = this.encoderSource;
		if (!bridge) {
			throw new Error('Talk break bridge is not connected.');
		}

		await bridge.beginTalk();
		if (this.mode !== 'talk' || this.encoderSource !== bridge) {
			return;
		}
		this.talkActive = true;
		this.applyDucking();
	}

	private async finishTalkBreak(): Promise<void> {
		if (this.mode !== 'talk' || !this.talkActive) {
			return;
		}

		const bridge = this.encoderSource;
		this.talkActive = false;
		this.applyDucking();
		await bridge?.endTalk();
	}

	private applyDucking() {
		if (!this.context || !this.options) {
			return;
		}

		if (this.mode === 'talk') {
			const micTarget = this.talkActive && Boolean(this.micGraph) ? this.options.micVolume : 0;
			this.micGain?.gain.setTargetAtTime(micTarget, this.context.currentTime, micTarget > 0 ? 0.015 : 0.08);
			return;
		}

		if (this.mode === 'voice') {
			const micTarget = this.micOpen && Boolean(this.micGraph) ? this.options.micVolume : 0;
			this.micGain?.gain.setTargetAtTime(micTarget, this.context.currentTime, micTarget > 0 ? 0.015 : 0.08);
			this.ambientGain?.gain.setTargetAtTime(ambientBedGain(this.options), this.context.currentTime, 0.05);
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
		const rms = rmsTimeDomainLevel(analyser, analyserData);
		const level = (rms - MIC_METER_FLOOR) / (MIC_METER_CEILING - MIC_METER_FLOOR);
		this.callbacks?.onMicLevel(Math.min(1, Math.max(0, Math.pow(level, 0.75))));
		this.micLevelFrame = requestAnimationFrame(() => this.updateMicLevel());
	}

	private updateLevel() {
		if (!this.analyser || !this.analyserData) {
			return;
		}

		const rms = rmsTimeDomainLevel(this.analyser, this.analyserData);
		this.callbacks?.onLevel(Math.min(1, Math.max(0.04, Math.pow(rms * 8, 0.7))));
		this.levelFrame = requestAnimationFrame(() => this.updateLevel());
	}
}

function studioSocketUrl(pathname: '/source' | '/talk-break'): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${protocol}//${window.location.host}${pathname}`;
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

function describeMicError(error: unknown): string {
	if (error instanceof DOMException) {
		if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
			return 'Browser microphone access is blocked for this page. Allow mic access in the address bar, then press Retry mic.';
		}
		if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
			return 'No microphone input was found by the browser. Check the device connection, then press Retry mic.';
		}
		if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
			return 'The selected microphone is busy or unavailable to the browser. Close other apps using it, then press Retry mic.';
		}
		if (error.name === 'OverconstrainedError' || error.name === 'ConstraintNotSatisfiedError') {
			return 'The selected microphone could not satisfy the requested capture format. Choose the default input or another mic.';
		}
	}

	return error instanceof Error ? error.message : 'Microphone is unavailable.';
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

function ambientBedGain(options: Pick<EngineOptions, 'ambientBedEnabled' | 'ambientBedLevel'>): number {
	if (!options.ambientBedEnabled) {
		return 0;
	}

	return Math.min(1, Math.max(0, options.ambientBedLevel)) * VOICE_AMBIENT_MAX_GAIN;
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
