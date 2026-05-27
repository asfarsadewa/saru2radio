<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		Bot,
		FolderOpen,
		ListMusic,
		MessageSquare,
		Mic,
		RefreshCw,
		Shuffle,
		SkipForward,
		StopCircle,
		TowerControl,
		Trash2,
		UploadCloud,
		Volume2,
		X
	} from '@lucide/svelte';
	import {
		clearAiDjActions,
		clearListenerMessages,
		deleteListenerMessage,
		getAiDjActions,
		getConfig,
		getLibrary,
		getListenerMessages,
		getNowPlaying,
		getStatus,
		getStudioState,
		getTunnel,
		pickFolder,
		playBroadcastNow,
		scanLibrary,
		skipBroadcast,
		startBroadcast,
		startTunnel,
		stopBroadcast,
		stopTunnel,
		updateBroadcastQueue,
		updateNowPlaying,
		updateStudioState
	} from '../lib/api';
	import { StudioEngine, type MicCaptureState, type MicColorMode } from '../lib/audio/studioEngine';
	import { createPlaybackQueue, cueTrackInQueue, reconcileQueueWithTracks, rotateQueueToTrack } from '../lib/queue';
	import type { AiDjAction, BroadcastStatus, LibraryState, ListenerMessage, NowPlaying, ServerConfig, Track, TunnelState } from '../lib/types';

	type BroadcastMode = 'direct' | 'mixer';
	type DirectProgramMode = 'songs' | 'voice';

	let config: ServerConfig | null = null;
	let library: LibraryState = {
		directory: '',
		tracks: [],
		preparing: false,
		lastScanAt: null,
		recursive: false,
		sourceKind: 'empty'
	};
	let status: BroadcastStatus | null = null;
	let tunnel: TunnelState = { running: false, url: null, startedAt: null, error: null, mode: null, hostname: null, configured: false };
	let directoryInput = '';
	let libraryRecursive = false;
	let queue: Track[] = [];
	let nowPlaying: NowPlaying | null = null;
	let listenerMessages: ListenerMessage[] = [];
	let aiDjActions: AiDjAction[] = [];
	let ordered = false;
	let errorMessage = '';
	let busyMessage = '';
	let outputLevel = 0.05;
	let micLevel = 0;
	let micDevices: MediaDeviceInfo[] = [];
	let selectedMicId = '';
	let micLabel = '';
	let micMessage = '';
	let micMuted = false;
	let micColor: MicColorMode = 'broadcast';
	let musicVolume = 0.92;
	let micVolume = 0.92;
	let duckingDb = -12;
	let monitor = false;
	let broadcastMode: BroadcastMode = 'direct';
	let directProgram: DirectProgramMode = 'songs';
	let activeBroadcastMode: BroadcastMode | null = null;
	let activeDirectProgram: DirectProgramMode | null = null;
	let inferredActiveDirectProgram: DirectProgramMode | null = null;
	let directProgramSwitching = false;
	let ambientBedEnabled = true;
	let ambientBedLevel = 0.28;
	let micLatched = false;
	let micHeld = false;
	let micOpen = false;
	let micReady = false;
	let pollTimer: number | undefined;
	let directMonitorAudio: HTMLAudioElement | null = null;
	let directMonitorBaseUrl = '';
	let directMonitorContext: AudioContext | null = null;
	let directMonitorSource: MediaElementAudioSourceNode | null = null;
	let directMonitorAnalyser: AnalyserNode | null = null;
	let directMonitorData: Uint8Array<ArrayBuffer> | null = null;
	let directMonitorLevelFrame = 0;
	const engine = new StudioEngine();

	$: readyTracks = library.tracks.filter((track) => track.cacheReady);
	$: missingCount = library.tracks.filter((track) => !track.cacheReady).length;
	$: onAir = Boolean(status?.onAir);
	$: sourceConnected = Boolean(status?.sourceConnected);
	$: activeListeners = status?.activeListeners ?? 0;
	$: activeListenerLabel = `${activeListeners} ${activeListeners === 1 ? 'LISTENER' : 'LISTENERS'}`;
	$: listenerUrl = tunnel.url ?? config?.listenerUrl ?? '';
	$: displayQueue = rotateQueueToTrack(queue, nowPlaying?.trackId);
	$: levelStyle = `--level: ${outputLevel.toFixed(3)};`;
	$: micOpen = micHeld || micLatched;
	$: micLevelStyle = `--mic-level: ${micLevel.toFixed(3)};`;
	$: directModeSelected = broadcastMode === 'direct';
	$: mixerOnAir = activeBroadcastMode === 'mixer';
	$: directOnAir = activeBroadcastMode === 'direct' || (onAir && directModeSelected && activeBroadcastMode !== 'mixer');
	$: inferredActiveDirectProgram = directOnAir ? (activeDirectProgram ?? inferDirectProgramFromNowPlaying()) : null;
	$: voiceProgramSelected = directModeSelected && directProgram === 'voice';
	$: voiceProgramOnAir = directOnAir && inferredActiveDirectProgram === 'voice';
	$: directSongsOnAir = directOnAir && inferredActiveDirectProgram !== 'voice';
	$: directProgramControlDisabled = directProgramSwitching || mixerOnAir || (!directModeSelected && !directOnAir);
	$: ambientBedLabel = `Bed ${Math.round(ambientBedLevel * 100)}%`;
	$: micButtonDisabled = directProgramSwitching || !onAir || !micReady || micMuted;
	$: micButtonLabel = !micReady || micMuted
		? 'No mic'
		: voiceProgramOnAir
			? micOpen
				? 'Mic live'
				: 'Open mic'
			: micOpen
				? directOnAir
					? 'Talking'
					: 'Mic open'
				: directOnAir
					? 'Hold talk'
					: 'Hold mic';
	$: micStatusLabel = micReady ? (micMuted ? 'MIC MUTED' : voiceProgramOnAir ? 'VOICE MIC READY' : directOnAir ? 'TALK BREAK READY' : 'MIC READY') : 'MIC NOT CONNECTED';
	$: micDetail = micMessage || micLabel || (voiceProgramOnAir ? 'Voice program standby.' : directOnAir ? 'Hold to pause songs and talk.' : 'Choose an input, then go on air.');

	onMount(async () => {
		await refreshAll();
		await refreshMicrophones();
		pollTimer = window.setInterval(refreshStatusOnly, 2500);
	});

	onDestroy(() => {
		if (pollTimer) {
			window.clearInterval(pollTimer);
		}
		stopDirectMonitor();
		void closeDirectMonitorMeter();
		void engine.stop();
	});

	async function refreshAll() {
		try {
			const [nextConfig, nextLibrary, nextStatus, nextTunnel, nextNowPlaying, nextListenerMessages, nextAiDjActions, studioState] = await Promise.all([
				getConfig(),
				getLibrary(),
				getStatus(),
				getTunnel(),
				getNowPlaying(),
				getListenerMessages(),
				getAiDjActions(),
				getStudioState()
			]);
			config = nextConfig;
			library = nextLibrary;
			status = nextStatus;
			tunnel = nextTunnel;
			nowPlaying = nextNowPlaying;
			listenerMessages = nextListenerMessages;
			aiDjActions = nextAiDjActions;
			ordered = studioState.ordered;
			libraryRecursive = studioState.broadcastRecursive;
			directoryInput = library.directory || studioState.broadcastDirectory;
			buildQueue();
		} catch (error) {
			setError(error);
		}
	}

	async function refreshStatusOnly() {
		try {
			[status, tunnel, nowPlaying, listenerMessages, aiDjActions] = await Promise.all([
				getStatus(),
				getTunnel(),
				getNowPlaying(),
				getListenerMessages(),
				getAiDjActions()
			]);
		} catch {
			// Polling should not interrupt the booth.
		}
	}

	async function chooseFolder() {
		errorMessage = '';
		busyMessage = 'Opening folder picker';
		try {
			const result = await pickFolder();
			directoryInput = result.directory;
			await scan();
		} catch (error) {
			setError(error);
		} finally {
			busyMessage = '';
		}
	}

	async function scan() {
		errorMessage = '';
		busyMessage = 'Scanning library';
		try {
			library = await scanLibrary(directoryInput, libraryRecursive);
			await updateStudioState({ broadcastRecursive: libraryRecursive });
			buildQueue();
			if (directSongsOnAir && queue.length > 0) {
				status = await updateBroadcastQueue(queue.map((track) => track.id));
			}
		} catch (error) {
			setError(error);
		} finally {
			busyMessage = '';
		}
	}

	function buildQueue() {
		queue = createPlaybackQueue(currentReadyTracks(), ordered, nowPlaying?.trackId);
		if (mixerOnAir && queue.length > 0) {
			engine.setQueue(queue);
		}
	}

	function reconcileDisplayedQueue() {
		queue = reconcileQueueWithTracks(queue, currentReadyTracks(), ordered);
		if (nowPlaying?.trackId) {
			queue = rotateQueueToTrack(queue, nowPlaying.trackId);
		}
	}

	function currentReadyTracks(): Track[] {
		return library.tracks.filter((track) => track.cacheReady);
	}

	async function goOnAir() {
		if (!config) {
			return;
		}
		errorMessage = '';
		if (broadcastMode === 'direct' && directProgram === 'voice') {
			await startVoiceProgram();
			return;
		}

		const directMode = broadcastMode === 'direct';
		let directTalkBreakStarted = false;
		if (directMode) {
			busyMessage = 'Starting talk break mic';
			await engine.stop();
			micLatched = false;
			micHeld = false;
			micReady = false;
			micLevel = 0;
			try {
				await engine.startTalkBreak(getEngineOptions(), getEngineCallbacks());
				await refreshMicrophones();
				directTalkBreakStarted = true;
			} catch (error) {
				await engine.stop();
				setError(error);
			}
		}
		busyMessage = 'Checking radio copies';
		try {
			library = await getLibrary();
		} catch (error) {
			if (directTalkBreakStarted) {
				await engine.stop();
			}
			busyMessage = '';
			setError(error);
			return;
		}
		reconcileDisplayedQueue();
		if (queue.length === 0) {
			if (directTalkBreakStarted) {
				await engine.stop();
			}
			busyMessage = '';
			errorMessage = 'Prepare at least one radio copy before going on air.';
			return;
		}

		try {
			if (directMode) {
				busyMessage = 'Starting direct stream';
				status = await startBroadcast(queue.map((track) => track.id));
				activeBroadcastMode = 'direct';
				activeDirectProgram = 'songs';
				directProgram = 'songs';
				outputLevel = 0.05;
				await syncDirectMonitor({ restart: true });
			} else {
				busyMessage = 'Starting DJ mixer';
				await engine.start(queue, getEngineOptions(), getEngineCallbacks());
				activeBroadcastMode = 'mixer';
				activeDirectProgram = null;
				status = await getStatus();
				await refreshMicrophones();
				outputLevel = 0.72;
			}
			nowPlaying = await getNowPlaying();
		} catch (error) {
			stopDirectMonitor();
			await engine.stop();
			await stopBroadcast();
			activeBroadcastMode = null;
			activeDirectProgram = null;
			setError(error);
		} finally {
			busyMessage = '';
		}
	}

	async function startVoiceProgram() {
		busyMessage = 'Starting voice program';
		stopDirectMonitor();
		await engine.stop();
		micLatched = false;
		micHeld = false;
		micReady = false;
		micLevel = 0;
		try {
			await engine.startVoiceProgram(getEngineOptions(), getEngineCallbacks());
			await refreshMicrophones();
			status = await getStatus();
			activeBroadcastMode = 'direct';
			activeDirectProgram = 'voice';
			directProgram = 'voice';
			outputLevel = 0.08;
			nowPlaying = {
				trackId: null,
				title: 'Live voice',
				artist: config?.stationName ?? 'saru2radio',
				startedAt: new Date().toISOString(),
				duration: null
			};
			try {
				nowPlaying = await updateNowPlaying({
					trackId: null,
					title: 'Live voice',
					artist: config?.stationName ?? 'saru2radio',
					duration: null
				});
			} catch {
				// The stream can keep running if metadata refresh races the source socket.
			}
			await syncDirectMonitor({ restart: true });
		} catch (error) {
			stopDirectMonitor();
			await engine.stop();
			try {
				status = await stopBroadcast();
			} catch {
				// The source may not have reached the server yet.
			}
			activeBroadcastMode = null;
			activeDirectProgram = null;
			setError(error);
		} finally {
			busyMessage = '';
		}
	}

	async function switchDirectSongsToVoice() {
		if (directProgramSwitching || voiceProgramOnAir) {
			return;
		}

		directProgramSwitching = true;
		errorMessage = '';
		busyMessage = 'Switching to voice program';
		stopDirectMonitor();
		await engine.stop();
		micLatched = false;
		micHeld = false;
		micReady = false;
		micLevel = 0;
		try {
			await engine.startVoiceProgram(getEngineOptions(), getEngineCallbacks());
			await refreshMicrophones();
			status = await getStatus();
			activeBroadcastMode = 'direct';
			activeDirectProgram = 'voice';
			directProgram = 'voice';
			outputLevel = 0.08;
			nowPlaying = {
				trackId: null,
				title: 'Live voice',
				artist: config?.stationName ?? 'saru2radio',
				startedAt: new Date().toISOString(),
				duration: null
			};
			try {
				nowPlaying = await updateNowPlaying({
					trackId: null,
					title: 'Live voice',
					artist: config?.stationName ?? 'saru2radio',
					duration: null
				});
			} catch {
				// The stream can keep running if metadata refresh races the source socket.
			}
			await syncDirectMonitor({ restart: true });
		} catch (error) {
			stopDirectMonitor();
			await engine.stop();
			activeBroadcastMode = 'direct';
			activeDirectProgram = 'songs';
			directProgram = 'songs';
			try {
				await engine.startTalkBreak(getEngineOptions(), getEngineCallbacks());
				await refreshMicrophones();
			} catch {
				// Keep the original voice-switch error visible; songs are still on air.
			}
			try {
				[status, nowPlaying] = await Promise.all([getStatus(), getNowPlaying()]);
				await syncDirectMonitor({ restart: true });
			} catch {
				// Preserve the visible songs mode if status refresh fails.
			}
			setError(error);
		} finally {
			busyMessage = '';
			directProgramSwitching = false;
		}
	}

	async function switchDirectVoiceToSongs() {
		if (directProgramSwitching || directSongsOnAir) {
			return;
		}

		directProgramSwitching = true;
		errorMessage = '';
		busyMessage = 'Checking song queue';
		try {
			library = await getLibrary();
			reconcileDisplayedQueue();
		} catch (error) {
			setError(error);
			busyMessage = '';
			directProgramSwitching = false;
			return;
		}
		if (queue.length === 0) {
			errorMessage = 'Prepare at least one radio copy before switching to Songs.';
			busyMessage = '';
			directProgramSwitching = false;
			return;
		}

		try {
			busyMessage = 'Starting direct songs';
			status = await startBroadcast(queue.map((track) => track.id));
		} catch (error) {
			try {
				status = await getStatus();
			} catch {
				// Keep the current voice UI if the status refresh fails.
			}
			activeBroadcastMode = 'direct';
			activeDirectProgram = 'voice';
			directProgram = 'voice';
			setError(error);
			busyMessage = '';
			directProgramSwitching = false;
			return;
		}

		activeBroadcastMode = 'direct';
		activeDirectProgram = 'songs';
		directProgram = 'songs';
		micLatched = false;
		micHeld = false;
		micReady = false;
		micLevel = 0;
		busyMessage = 'Starting talk break mic';
		try {
			await engine.stop();
			await engine.startTalkBreak(getEngineOptions(), getEngineCallbacks());
			await refreshMicrophones();
		} catch (error) {
			await engine.stop();
			setError(error);
		}
		try {
			nowPlaying = await getNowPlaying();
		} catch {
			// The server playout already owns now-playing; the next poll will refresh it.
		}
		outputLevel = 0.05;
		await syncDirectMonitor({ restart: true });
		busyMessage = '';
		directProgramSwitching = false;
	}

	async function goOffAir() {
		directProgramSwitching = false;
		stopDirectMonitor();
		await engine.stop();
		micLatched = false;
		micHeld = false;
		micReady = false;
		micLevel = 0;
		micLabel = '';
		micMessage = '';
		micMuted = false;
		status = await stopBroadcast();
		activeBroadcastMode = null;
		activeDirectProgram = null;
		nowPlaying = null;
		outputLevel = 0.05;
	}

	async function skipTrack() {
		if (voiceProgramOnAir) {
			return;
		}
		if (activeBroadcastMode === 'direct') {
			status = await skipBroadcast();
			nowPlaying = await getNowPlaying();
			return;
		}
		engine.skip();
	}

	function setMic(open: boolean) {
		micHeld = open;
		void applyMicState();
	}

	function beginMicHold(event: PointerEvent) {
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		setMic(true);
	}

	function endMicHold(event: PointerEvent) {
		if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		setMic(false);
	}

	function handleMicPointerDown(event: PointerEvent) {
		if (voiceProgramOnAir) {
			return;
		}
		beginMicHold(event);
	}

	function handleMicPointerUp(event: PointerEvent) {
		if (voiceProgramOnAir) {
			return;
		}
		endMicHold(event);
	}

	function handleMicClick() {
		if (!voiceProgramOnAir) {
			return;
		}
		toggleLatch();
	}

	function toggleLatch() {
		micLatched = !micLatched;
		void applyMicState();
	}

	async function setDirectProgram(mode: DirectProgramMode) {
		if (directProgramSwitching) {
			return;
		}
		if (!onAir) {
			directProgram = mode;
			closeMicControl();
			return;
		}
		if (!directOnAir) {
			return;
		}
		if (mode === 'voice') {
			await switchDirectSongsToVoice();
			return;
		}
		await switchDirectVoiceToSongs();
	}

	function chooseDirectProgram(mode: DirectProgramMode) {
		void setDirectProgram(mode);
	}

	function isDirectProgramButtonDisabled(): boolean {
		return directProgramControlDisabled;
	}

	function visibleDirectProgram(): DirectProgramMode {
		if (directOnAir && inferredActiveDirectProgram) {
			return inferredActiveDirectProgram;
		}
		return directProgram;
	}

	function inferDirectProgramFromNowPlaying(): DirectProgramMode {
		return nowPlaying?.trackId === null && nowPlaying.title === 'Live voice' ? 'voice' : 'songs';
	}

	function applyAudioOptions() {
		engine.setOptions(getEngineOptions());
		void syncDirectMonitor();
	}

	async function syncDirectMonitor(options: { restart?: boolean } = {}) {
		const shouldPlay = monitor && directOnAir && onAir;
		if (!shouldPlay) {
			stopDirectMonitor();
			return;
		}
		if (!directMonitorAudio) {
			return;
		}

		const streamUrl = '/api/monitor/live.mp3';
		if (options.restart || streamUrl !== directMonitorBaseUrl || !directMonitorAudio.src) {
			directMonitorBaseUrl = streamUrl;
			const separator = streamUrl.includes('?') ? '&' : '?';
			directMonitorAudio.src = `${streamUrl}${separator}monitor=${Date.now()}`;
			directMonitorAudio.load();
		}

		try {
			const meterReady = await ensureDirectMonitorMeter();
			await directMonitorAudio.play();
			if (meterReady) {
				startDirectMonitorMeter();
			}
		} catch {
			if (monitor && directOnAir && onAir) {
				errorMessage = 'Local monitor could not start. Toggle Local monitor again.';
			}
		}
	}

	function stopDirectMonitor() {
		stopDirectMonitorMeter();
		directMonitorBaseUrl = '';
		if (activeBroadcastMode !== 'mixer') {
			outputLevel = 0.05;
		}
		if (!directMonitorAudio) {
			return;
		}
		directMonitorAudio.pause();
		directMonitorAudio.removeAttribute('src');
		directMonitorAudio.load();
	}

	async function ensureDirectMonitorMeter() {
		if (!directMonitorAudio) {
			return false;
		}

		const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
		if (!AudioContextConstructor) {
			return false;
		}

		if (!directMonitorContext) {
			directMonitorContext = new AudioContextConstructor({ latencyHint: 'playback' });
		}
		if (!directMonitorSource) {
			directMonitorSource = directMonitorContext.createMediaElementSource(directMonitorAudio);
			directMonitorAnalyser = directMonitorContext.createAnalyser();
			directMonitorAnalyser.fftSize = 512;
			directMonitorAnalyser.smoothingTimeConstant = 0.5;
			directMonitorData = new Uint8Array(directMonitorAnalyser.fftSize);
			directMonitorSource.connect(directMonitorAnalyser);
			directMonitorAnalyser.connect(directMonitorContext.destination);
		}
		if (directMonitorContext.state !== 'running') {
			await directMonitorContext.resume();
		}

		return Boolean(directMonitorAnalyser && directMonitorData);
	}

	function startDirectMonitorMeter() {
		stopDirectMonitorMeter();
		updateDirectMonitorMeter();
	}

	function updateDirectMonitorMeter() {
		if (!directMonitorAnalyser || !directMonitorData || !monitor || !directOnAir || !onAir) {
			stopDirectMonitorMeter();
			return;
		}

		directMonitorAnalyser.getByteTimeDomainData(directMonitorData);
		let sum = 0;
		for (const value of directMonitorData) {
			const normalized = (value - 128) / 128;
			sum += normalized * normalized;
		}
		const rms = Math.sqrt(sum / directMonitorData.length);
		outputLevel = Math.min(1, Math.max(0.04, Math.pow(rms * 8, 0.7)));
		directMonitorLevelFrame = window.requestAnimationFrame(updateDirectMonitorMeter);
	}

	function stopDirectMonitorMeter() {
		if (directMonitorLevelFrame) {
			window.cancelAnimationFrame(directMonitorLevelFrame);
			directMonitorLevelFrame = 0;
		}
	}

	async function closeDirectMonitorMeter() {
		stopDirectMonitorMeter();
		directMonitorSource?.disconnect();
		directMonitorAnalyser?.disconnect();
		directMonitorSource = null;
		directMonitorAnalyser = null;
		directMonitorData = null;
		if (directMonitorContext && directMonitorContext.state !== 'closed') {
			await directMonitorContext.close();
		}
		directMonitorContext = null;
	}

	async function retryMic() {
		errorMessage = '';
		closeMicControl();
		micReady = false;
		micLevel = 0;
		micMessage = 'Requesting microphone access.';
		try {
			await engine.retryMicrophone();
			await refreshMicrophones();
		} catch (error) {
			setError(error);
		}
	}

	async function changeMicDevice() {
		errorMessage = '';
		closeMicControl();
		micReady = false;
		micLevel = 0;
		micMessage = 'Switching microphone input.';
		try {
			await engine.selectMicrophone(selectedMicId);
			await refreshMicrophones();
		} catch (error) {
			setError(error);
		}
	}

	function closeMicControl() {
		micHeld = false;
		micLatched = false;
		void engine.setMicOpen(false).catch(setError);
	}

	async function applyMicState() {
		try {
			await engine.setMicOpen(micHeld || micLatched);
		} catch (error) {
			setError(error);
		}
	}

	function getEngineCallbacks() {
		return {
			onTrack: handleTrackChange,
			onLevel: (level: number) => {
				outputLevel = level;
			},
			onMicLevel: (level: number) => {
				micLevel = level;
			},
			onMicState: (state: MicCaptureState) => {
				applyMicCaptureState(state);
			},
			onError: (message: string) => {
				errorMessage = message;
			},
			onSourceState: (connected: boolean) => {
				if (status) {
					status = { ...status, sourceConnected: connected };
				}
			}
		};
	}

	function applyMicCaptureState(state: MicCaptureState) {
		micReady = state.connected;
		micLabel = state.label;
		micMuted = state.muted;
		micMessage = state.message ?? '';
		if (!state.connected) {
			micLevel = 0;
		}
	}

	async function refreshMicrophones() {
		if (!navigator.mediaDevices?.enumerateDevices) {
			micDevices = [];
			return;
		}

		try {
			micDevices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
		} catch {
			micDevices = [];
		}
	}

	async function handleTrackChange(track: Track) {
		nowPlaying = {
			trackId: track.id,
			title: track.title,
			artist: track.artist,
			startedAt: new Date().toISOString(),
			duration: track.duration
		};
		try {
			nowPlaying = await updateNowPlaying({
				trackId: track.id,
				title: track.title,
				artist: track.artist,
				duration: track.duration
			});
		} catch {
			// Local display should keep moving even if a metadata update races the source socket.
		}
	}

	async function playTrack(track: Track) {
		if (!track.cacheReady) {
			return;
		}
		if (voiceProgramOnAir) {
			return;
		}
		const previousQueue = queue;
		queue = cueTrackInQueue(track, currentReadyTracks(), queue, ordered);
		if (onAir) {
			if (activeBroadcastMode === 'direct') {
				try {
					status = await playBroadcastNow(queue.map((candidate) => candidate.id));
					nowPlaying = await getNowPlaying();
				} catch (error) {
					queue = previousQueue;
					setError(error);
				}
				return;
			}
			try {
				await engine.playNow(track);
				engine.setQueue(queue);
			} catch (error) {
				queue = previousQueue;
				setError(error);
			}
			return;
		}
	}

	async function toggleOrderMode() {
		const previousOrdered = ordered;
		const previousQueue = queue;
		ordered = !ordered;
		buildQueue();
		try {
			if (directSongsOnAir && queue.length > 0) {
				status = await updateBroadcastQueue(queue.map((track) => track.id));
			}
			await updateStudioState({ ordered });
		} catch (error) {
			ordered = previousOrdered;
			queue = previousQueue;
			setError(error);
		}
	}

	function getEngineOptions() {
		return {
			bitrateKbps: config?.bitrateKbps ?? 64,
			musicVolume: Number(musicVolume),
			micVolume: Number(micVolume),
			micDeviceId: selectedMicId,
			micColor,
			duckingDb: Number(duckingDb),
			monitor: activeBroadcastMode === 'direct' || (activeBroadcastMode === null && broadcastMode === 'direct') ? false : monitor,
			ambientBedEnabled,
			ambientBedLevel: Number(ambientBedLevel)
		};
	}

	async function toggleTunnel() {
		try {
			tunnel = tunnel.running ? await stopTunnel() : await startTunnel();
		} catch (error) {
			setError(error);
		}
	}

	async function copyListenerUrl() {
		if (listenerUrl) {
			await navigator.clipboard.writeText(listenerUrl);
		}
	}

	async function dismissListenerRequest(id: string) {
		try {
			listenerMessages = await deleteListenerMessage(id);
		} catch (error) {
			setError(error);
		}
	}

	async function clearListenerRequests() {
		try {
			listenerMessages = await clearListenerMessages();
		} catch (error) {
			setError(error);
		}
	}

	async function clearAiDjActionLog() {
		try {
			aiDjActions = await clearAiDjActions();
		} catch (error) {
			setError(error);
		}
	}

	function setError(error: unknown) {
		errorMessage = error instanceof Error ? error.message : 'Unexpected error.';
	}

	function formatDuration(seconds: number | null): string {
		if (!seconds || !Number.isFinite(seconds)) {
			return '--:--';
		}
		const minutes = Math.floor(seconds / 60);
		const rest = Math.floor(seconds % 60).toString().padStart(2, '0');
		return `${minutes}:${rest}`;
	}

	function formatRequestTime(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			return '';
		}
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function aiDjStatusLabel(action: AiDjAction): string {
		switch (action.status) {
			case 'analyzing':
				return 'Analyzing';
			case 'played_now':
				return 'Played now';
			case 'ignored_not_song':
				return 'Not a song';
			case 'ignored_unavailable':
				return 'Unavailable';
			case 'ignored_ambiguous':
				return 'Ambiguous';
			case 'ignored_unsafe':
				return 'Unsafe ignored';
			case 'log_only_mode':
				return 'Log only';
			case 'disabled':
				return 'Disabled';
			case 'failed':
				return 'Failed';
		}
	}

	function aiDjStatusClass(action: AiDjAction): string {
		if (action.status === 'played_now') {
			return 'played';
		}
		if (action.status === 'analyzing') {
			return 'pending';
		}
		if (action.status === 'failed' || action.status === 'ignored_unsafe') {
			return 'warning';
		}
		return 'ignored';
	}
</script>

<main class="studio-shell">
	<header class="studio-header">
		<div class="brand">
			<h1 class="wordmark">saru2radio</h1>
			<span class="eyebrow">local shortwave booth</span>
		</div>
		<div class="header-status">
			<span class="status-pill">
				<span class:live={onAir} class:offline={!onAir} class="status-dot"></span>
				{onAir ? 'ON AIR' : readyTracks.length > 0 ? 'READY' : 'OFF AIR'}
			</span>
			<span class="status-pill">
				<span class:ready={sourceConnected} class:offline={!sourceConnected} class="status-dot"></span>
				ICECAST
			</span>
			<span class="status-pill">
				<span class:ready={activeListeners > 0} class:offline={activeListeners === 0} class="status-dot"></span>
				{activeListenerLabel}
			</span>
			<span class="status-pill">{config?.bitrateKbps ?? 64} KBPS / 22.05 KHZ</span>
		</div>
	</header>

	<section class="studio-grid">
		<aside class="panel library-panel">
			<div class="panel-head">
				<div>
					<span class="eyebrow">library</span>
					<h2>Broadcast library</h2>
				</div>
				<button class="icon-button" type="button" aria-label="Refresh" on:click={refreshAll}>
					<RefreshCw />
				</button>
			</div>

			<label class="field">
				<span>Broadcast folder</span>
				<input bind:value={directoryInput} placeholder="C:\Music\saru2radio" />
			</label>
			<label class="toggle compact-toggle">
				<input type="checkbox" bind:checked={libraryRecursive} on:change={() => updateStudioState({ broadcastRecursive: libraryRecursive })} />
				<span>Include subfolders</span>
			</label>

			<div class="action-row">
				<button class="tool-button" type="button" on:click={chooseFolder}>
					<FolderOpen />
					Pick
				</button>
				<button class="tool-button" type="button" on:click={scan}>
					<ListMusic />
					Scan
				</button>
			</div>

			<div class="library-stats">
				<span>{library.tracks.length} tracks</span>
				<span>{readyTracks.length} ready to air</span>
				<span>{missingCount} pending</span>
			</div>

			<div class="track-list" aria-label="Track list">
				{#each library.tracks as track (track.id)}
					<button
						class:active={nowPlaying?.trackId === track.id}
						class:ready={track.cacheReady}
						class:error={Boolean(track.error)}
						class="track-row"
						type="button"
						disabled={!track.cacheReady || voiceProgramOnAir || directProgramSwitching}
						on:click={() => playTrack(track)}
					>
						<div>
							<strong>{track.title}</strong>
							<span>{track.artist}</span>
							{#if track.error}
								<em>{track.error}</em>
							{/if}
						</div>
						<time>{formatDuration(track.duration)}</time>
					</button>
				{/each}
				{#if library.tracks.length === 0}
					<p class="empty-note">Choose a broadcast folder and scan local MP3 files.</p>
				{/if}
			</div>
		</aside>

		<section class="broadcast-panel">
			<div class="dial panel" style={levelStyle}>
				<div class="frequency">
					<span class="eyebrow">frequency</span>
					<strong>8.010 MHz</strong>
				</div>
				<div class="vu" aria-label="Output level">
					<div class="vu-needle"></div>
					<div class="vu-scale">
						<span>-30</span><span>-12</span><span>0</span>
					</div>
				</div>
				<div class="now">
					<span class="eyebrow">now playing</span>
					<h2>{nowPlaying?.title ?? (onAir ? 'Carrier open' : 'Silent carrier')}</h2>
					<p>{nowPlaying?.artist ?? 'saru2radio'}</p>
				</div>
			</div>

			<div class="transport panel">
				<button class:live={onAir} class="broadcast-button" type="button" disabled={directProgramSwitching} on:click={onAir ? goOffAir : goOnAir}>
					{#if onAir}
						<StopCircle />
						OFF AIR
					{:else}
						<TowerControl />
						ON AIR
					{/if}
				</button>
				<button class="icon-button" type="button" disabled={!onAir || voiceProgramOnAir || directProgramSwitching} aria-label="Skip track" on:click={skipTrack}>
					<SkipForward />
				</button>
				<button class="tool-button" type="button" disabled={voiceProgramSelected || voiceProgramOnAir || directProgramSwitching} on:click={toggleOrderMode}>
					<Shuffle />
					{ordered ? 'Ordered' : 'Shuffle'}
				</button>
				<select class="mode-select" bind:value={broadcastMode} disabled={onAir} aria-label="Broadcast mode">
					<option value="direct">Direct songs</option>
					<option value="mixer">DJ mixer</option>
				</select>
				{#if directModeSelected || directOnAir}
					<div class="direct-program-toggle" aria-label="Direct program">
						<button
							class:active={visibleDirectProgram() === 'songs'}
							type="button"
							disabled={isDirectProgramButtonDisabled()}
							on:click={() => chooseDirectProgram('songs')}
						>
							Songs
						</button>
						<button
							class:active={visibleDirectProgram() === 'voice'}
							type="button"
							disabled={isDirectProgramButtonDisabled()}
							on:click={() => chooseDirectProgram('voice')}
						>
							Voice
						</button>
					</div>
				{/if}
			</div>

			<div class="facade panel">
				<div>
					<span class="eyebrow">listener facade</span>
					<p>{listenerUrl || 'No public URL yet'}</p>
				</div>
				<button class="tool-button" type="button" disabled={!config?.cloudflaredAvailable} on:click={toggleTunnel}>
					<UploadCloud />
					{tunnel.running ? 'Stop tunnel' : 'Start tunnel'}
				</button>
				<button class="ghost-button" type="button" disabled={!listenerUrl} on:click={copyListenerUrl}>Copy URL</button>
			</div>

			<div class="requests-panel panel">
				<div class="panel-head">
					<div>
						<span class="eyebrow">listener requests</span>
						<h2>Request line</h2>
					</div>
					<button
						class="icon-button"
						type="button"
						disabled={listenerMessages.length === 0}
						aria-label="Clear listener requests"
						on:click={clearListenerRequests}
					>
						<Trash2 />
					</button>
				</div>

				<div class="request-panel-body">
					<section class="request-section" aria-label="Listener request inbox">
						<div class="request-section-head">
							<span class="eyebrow">inbox</span>
							<span>{listenerMessages.length}</span>
						</div>
						<div class="request-inbox">
							{#each listenerMessages as request (request.id)}
								<article class="request-card">
									<div>
										<MessageSquare />
										<strong>{request.name}</strong>
										<time datetime={request.receivedAt}>{formatRequestTime(request.receivedAt)}</time>
									</div>
									<button class="icon-button" type="button" aria-label={`Dismiss request from ${request.name}`} on:click={() => dismissListenerRequest(request.id)}>
										<X />
									</button>
									<p>{request.message}</p>
								</article>
							{/each}
							{#if listenerMessages.length === 0}
								<p class="empty-note">No listener requests yet.</p>
							{/if}
						</div>
					</section>

					<section class="request-section" aria-label="AI DJ actions">
						<div class="request-section-head">
							<div>
								<span class="eyebrow">AI DJ actions</span>
								<span>{config?.aiDj.configured ? config.aiDj.model : 'OPENAI_API_KEY missing'}</span>
							</div>
							<button
								class="icon-button"
								type="button"
								disabled={aiDjActions.length === 0}
								aria-label="Clear AI DJ actions"
								on:click={clearAiDjActionLog}
							>
								<Trash2 />
							</button>
						</div>
						<div class="ai-action-list">
							{#each aiDjActions as action (action.id)}
								<article class="ai-action-card">
									<div class="ai-action-meta">
										<Bot />
										<span class={`ai-status ${aiDjStatusClass(action)}`}>{aiDjStatusLabel(action)}</span>
										<time datetime={action.updatedAt}>{formatRequestTime(action.updatedAt)}</time>
									</div>
									<p class="ai-request"><strong>{action.listenerName}</strong>: {action.requestMessage}</p>
									{#if action.matchedTrackTitle}
										<p class="ai-track">{action.matchedTrackTitle} - {action.matchedTrackArtist}</p>
									{/if}
									<p>{action.reason}</p>
								</article>
							{/each}
							{#if aiDjActions.length === 0}
								<p class="empty-note">No AI DJ actions yet.</p>
							{/if}
						</div>
					</section>
				</div>
			</div>
		</section>

		<aside class="panel mixer-panel">
			<div class="panel-head">
				<div>
					<span class="eyebrow">mixer</span>
					<h2>DJ talk-over</h2>
				</div>
				<Volume2 />
			</div>

			<div class="mic-pad">
				<button
					aria-pressed={micOpen}
					class:active={micOpen && micReady && !micMuted}
					class:latched={micLatched}
					class:missing={micOpen && (!micReady || micMuted)}
					class="mic-button"
					type="button"
					disabled={micButtonDisabled}
					on:click={handleMicClick}
					on:pointerdown={handleMicPointerDown}
					on:pointerup={handleMicPointerUp}
					on:pointercancel={handleMicPointerUp}
				>
					<Mic />
					{micButtonLabel}
				</button>
				{#if broadcastMode === 'mixer' || mixerOnAir}
					<button class="tool-button" type="button" disabled={!mixerOnAir} on:click={toggleLatch}>
						{micLatched ? 'Unlatch' : 'Latch'}
					</button>
				{/if}
			</div>

			<div class="mic-select-grid">
				<label class="field mic-device">
					<span>Microphone input</span>
					<select bind:value={selectedMicId} on:change={changeMicDevice}>
						<option value="">Default browser microphone</option>
						{#each micDevices as device, index (device.deviceId)}
							<option value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>
						{/each}
					</select>
				</label>

				<label class="field">
					<span>Mic color</span>
					<select bind:value={micColor} on:change={applyAudioOptions}>
						<option value="broadcast">Broadcast</option>
						<option value="shortwave">Shortwave</option>
						<option value="clean">Clean</option>
					</select>
				</label>
			</div>

			<div class="mic-status" style={micLevelStyle}>
				<div>
					<span class:ready={micReady && !micMuted} class:offline={!micReady || micMuted} class="status-dot"></span>
					<span>{micStatusLabel}</span>
				</div>
				<div class="mic-meter" aria-label="Microphone signal">
					<span></span>
				</div>
				<p>{micDetail}</p>
				<button class="tool-button" type="button" disabled={!onAir} on:click={retryMic}>Retry mic</button>
			</div>

			<label class="range">
				<span>Music</span>
				<input type="range" min="0" max="1.2" step="0.01" bind:value={musicVolume} disabled={directOnAir || voiceProgramSelected} on:input={applyAudioOptions} />
			</label>
			<label class="range">
				<span>Mic</span>
				<input type="range" min="0" max="1.4" step="0.01" bind:value={micVolume} on:input={applyAudioOptions} />
			</label>
			<label class="range">
				<span>Ducking {duckingDb} dB</span>
				<input type="range" min="-24" max="-3" step="1" bind:value={duckingDb} disabled={directOnAir || voiceProgramSelected} on:input={applyAudioOptions} />
			</label>
			{#if voiceProgramSelected || voiceProgramOnAir}
				<label class="toggle">
					<input type="checkbox" bind:checked={ambientBedEnabled} on:change={applyAudioOptions} />
					<span>Ambient bed</span>
				</label>
				<label class="range">
					<span>{ambientBedLabel}</span>
					<input type="range" min="0" max="1" step="0.01" bind:value={ambientBedLevel} disabled={!ambientBedEnabled} on:input={applyAudioOptions} />
				</label>
			{/if}
			<label class="toggle">
				<input type="checkbox" bind:checked={monitor} on:change={applyAudioOptions} />
				<span>Local monitor</span>
			</label>

			<div class="queue-list">
				<span class="eyebrow">queue</span>
				<div class="queue-items">
					{#each displayQueue.slice(0, 8) as track (track.id)}
						<p class:active={nowPlaying?.trackId === track.id}>{track.title}</p>
					{/each}
					{#if queue.length === 0}
						<p class="empty-note">{voiceProgramSelected || voiceProgramOnAir ? 'Voice program' : 'Prepared songs appear here.'}</p>
					{/if}
				</div>
			</div>
		</aside>
	</section>

	{#if busyMessage || errorMessage}
		<footer class:error={Boolean(errorMessage)} class="toast">
			{errorMessage || busyMessage}
		</footer>
	{/if}
</main>

<audio bind:this={directMonitorAudio} preload="none" aria-hidden="true"></audio>

<style>
	.studio-shell {
		display: flex;
		height: 100dvh;
		min-height: 0;
		flex-direction: column;
		overflow: hidden;
		padding: 18px;
	}

	.studio-header,
	.header-status,
	.panel-head,
	.action-row,
	.library-stats,
	.transport,
	.facade,
	.mic-pad {
		display: flex;
		align-items: center;
	}

	.studio-header {
		flex: 0 0 auto;
		justify-content: space-between;
		gap: 18px;
		margin-bottom: 14px;
	}

	.brand {
		display: grid;
		gap: 4px;
	}

	.header-status {
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}

	.studio-grid {
		flex: 1 1 auto;
		display: grid;
		grid-template-columns: minmax(280px, 0.85fr) minmax(420px, 1.35fr) minmax(280px, 0.8fr);
		gap: 12px;
		min-height: 0;
		overflow: hidden;
	}

	.library-panel,
	.mixer-panel,
	.broadcast-panel {
		min-height: 0;
		min-width: 0;
	}

	.library-panel,
	.mixer-panel {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 14px;
	}

	.broadcast-panel {
		display: grid;
		grid-template-rows: minmax(216px, 0.9fr) auto auto minmax(160px, 0.6fr);
		gap: 12px;
		overflow: hidden;
	}

	.panel-head {
		justify-content: space-between;
		gap: 12px;
	}

	.panel-head h2 {
		margin: 4px 0 0;
		font-family: var(--serif);
		font-size: 26px;
		font-style: italic;
		font-weight: 400;
	}

	.field {
		display: grid;
		gap: 6px;
	}

	.field span,
	.range span {
		color: var(--ink-faint);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	input,
	select {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.58);
		color: var(--ink);
		padding: 10px 11px;
	}

	select {
		appearance: auto;
	}

	.action-row {
		gap: 8px;
	}

	.library-stats {
		justify-content: space-between;
		gap: 8px;
		color: var(--ink-dim);
		font-size: 11px;
		text-transform: uppercase;
	}

	.track-list,
	.queue-list {
		display: grid;
		gap: 6px;
		overflow: auto;
	}

	.track-list {
		flex: 1 1 auto;
		min-height: 0;
		padding-right: 2px;
	}

	.track-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		width: 100%;
		padding: 9px;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.35);
		color: var(--ink);
		opacity: 0.58;
		text-align: left;
	}

	.track-row.ready {
		opacity: 1;
	}

	.track-row.active {
		border-color: rgba(31, 118, 108, 0.46);
		background: rgba(31, 118, 108, 0.08);
	}

	.track-row.error {
		border-color: rgba(181, 31, 36, 0.42);
		opacity: 1;
	}

	.track-row strong,
	.track-row span,
	.track-row em {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.track-row strong {
		font-size: 12px;
	}

	.track-row span,
	.track-row em,
	.track-row time,
	.empty-note,
	.facade p,
	.now p {
		color: var(--ink-dim);
		font-size: 11px;
	}

	.track-row em {
		margin-top: 3px;
		color: var(--signal);
		font-style: normal;
	}

	.dial {
		position: relative;
		display: grid;
		grid-template-rows: auto minmax(70px, 0.5fr) minmax(78px, auto);
		gap: 8px;
		min-height: 0;
		padding: 16px 20px;
		overflow: hidden;
		background:
			linear-gradient(180deg, rgba(20, 19, 17, 0.04), transparent),
			var(--panel);
	}

	.frequency {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
	}

	.frequency strong {
		font-size: clamp(1.8rem, 3.4vw, 2.75rem);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0;
		line-height: 0.92;
	}

	.vu {
		position: relative;
		align-self: center;
		width: min(68%, 360px);
		aspect-ratio: 4 / 1;
		margin: 0 auto;
		border-bottom: 1px solid var(--line-strong);
		background:
			radial-gradient(circle at 50% 100%, rgba(181, 31, 36, 0.12), transparent 58%),
			linear-gradient(90deg, rgba(20, 19, 17, 0.08) 1px, transparent 1px) 0 0 / 36px 100%;
	}

	.vu-needle {
		position: absolute;
		left: 50%;
		bottom: 0;
		width: 2px;
		height: 90%;
		background: var(--signal);
		transform: rotate(calc(-44deg + var(--level) * 88deg));
		transform-origin: 50% 100%;
		transition: transform 90ms linear;
	}

	.vu-scale {
		position: absolute;
		right: 0;
		bottom: 8px;
		left: 0;
		display: flex;
		justify-content: space-between;
		color: var(--ink-faint);
		font-size: 10px;
	}

	.now {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.now h2 {
		display: -webkit-box;
		max-width: 100%;
		margin: 5px 0 4px;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		font-family: var(--serif);
		font-size: clamp(1.45rem, 2.8vw, 2.25rem);
		font-style: italic;
		font-weight: 400;
		line-height: 1.02;
		letter-spacing: 0;
		overflow-wrap: anywhere;
	}

	.transport,
	.facade {
		justify-content: space-between;
		gap: 10px;
		padding: 10px;
	}

	.transport {
		--transport-control-height: 58px;
		align-items: stretch;
		flex-wrap: wrap;
	}

	.transport .broadcast-button,
	.transport .icon-button,
	.transport .tool-button,
	.transport .mode-select,
	.transport .direct-program-toggle {
		height: var(--transport-control-height);
		min-height: var(--transport-control-height);
	}

	.transport .icon-button {
		width: var(--transport-control-height);
	}

	.transport .tool-button,
	.transport .mode-select {
		line-height: 1;
	}

	.broadcast-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		flex: 1;
		border-radius: 4px;
		background: var(--ink);
		color: var(--paper);
		font-size: 13px;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.broadcast-button.live {
		background: var(--signal);
	}

	.broadcast-button :global(svg) {
		width: 20px;
		height: 20px;
	}

	.mode-select {
		flex: 0 0 138px;
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.direct-program-toggle {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		flex: 0 1 132px;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.45);
	}

	.direct-program-toggle button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		padding: 0 8px;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--ink-dim);
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.direct-program-toggle button + button {
		border-left: 1px solid var(--line);
	}

	.direct-program-toggle button.active {
		background: var(--ink);
		color: var(--paper);
	}

	.facade p {
		max-width: 38vw;
		margin: 4px 0 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.requests-panel {
		display: grid;
		min-height: 0;
		grid-template-rows: auto minmax(0, 1fr);
		gap: 8px;
		overflow: hidden;
		padding: 10px;
	}

	.requests-panel .panel-head h2 {
		font-size: 20px;
	}

	.request-panel-body,
	.request-section,
	.request-inbox,
	.ai-action-list {
		display: grid;
		min-height: 0;
	}

	.request-panel-body {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.request-section {
		grid-template-rows: auto minmax(0, 1fr);
		gap: 6px;
		overflow: hidden;
	}

	.request-section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--ink-faint);
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
	}

	.request-section-head > div {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 8px;
	}

	.request-section-head span:not(.eyebrow) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.request-inbox,
	.ai-action-list {
		align-content: start;
		gap: 8px;
		overflow: auto;
		padding-right: 2px;
	}

	.request-card,
	.ai-action-card {
		display: grid;
		gap: 7px 10px;
		padding: 9px;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.32);
	}

	.request-card {
		grid-template-columns: minmax(0, 1fr) auto;
	}

	.request-card > div {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 7px;
	}

	.request-card strong {
		min-width: 0;
		overflow: hidden;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.request-card time {
		flex: 0 0 auto;
		color: var(--ink-faint);
		font-size: 10px;
	}

	.request-card p {
		grid-column: 1 / -1;
		margin: 0;
		color: var(--ink);
		font-size: 12px;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.request-card :global(svg) {
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
	}

	.request-card .icon-button {
		width: 30px;
		min-height: 30px;
	}

	.ai-action-card {
		grid-template-columns: minmax(0, 1fr);
	}

	.ai-action-meta {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 7px;
	}

	.ai-action-meta :global(svg) {
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
	}

	.ai-action-meta time {
		margin-left: auto;
		color: var(--ink-faint);
		font-size: 10px;
	}

	.ai-status {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		min-height: 20px;
		padding: 0 7px;
		border-radius: 999px;
		background: rgba(20, 19, 17, 0.08);
		color: var(--ink-dim);
		font-size: 9px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.ai-status.played {
		background: rgba(31, 118, 108, 0.14);
		color: #1f766c;
	}

	.ai-status.pending {
		background: rgba(213, 166, 66, 0.2);
		color: #775a15;
	}

	.ai-status.warning {
		background: rgba(181, 31, 36, 0.12);
		color: var(--signal);
	}

	.ai-action-card p {
		margin: 0;
		color: var(--ink);
		font-size: 11px;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.ai-action-card .ai-request {
		color: var(--ink-dim);
	}

	.ai-action-card .ai-track {
		color: #1f766c;
		font-weight: 700;
	}

	.mic-pad {
		gap: 8px;
		align-items: stretch;
	}

	.mic-select-grid {
		display: grid;
		gap: 10px;
	}

	.mic-button {
		display: grid;
		width: 100%;
		min-height: clamp(104px, 18dvh, 152px);
		place-items: center;
		border-radius: 6px;
		background: var(--panel-dark);
		color: var(--paper);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		touch-action: none;
		user-select: none;
	}

	.mic-button.active,
	.mic-button.latched {
		background: var(--signal);
	}

	.mic-button.missing {
		background: #6c241f;
	}

	.mic-button :global(svg) {
		width: 26px;
		height: 26px;
	}

	.mic-status {
		display: grid;
		gap: 7px;
	}

	.mic-status > div:first-child {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--ink-dim);
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.mic-meter {
		height: 8px;
		overflow: hidden;
		border-radius: 999px;
		background: rgba(20, 19, 17, 0.12);
	}

	.mic-meter span {
		display: block;
		width: calc(var(--mic-level) * 100%);
		height: 100%;
		border-radius: inherit;
		background: var(--signal);
		transition: width 80ms linear;
	}

	.mic-status p {
		margin: 0;
		color: var(--ink-dim);
		font-size: 11px;
		line-height: 1.35;
	}

	.range {
		display: grid;
		gap: 8px;
	}

	.range input {
		padding: 0;
		accent-color: var(--signal);
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--ink-dim);
		font-size: 12px;
	}

	.compact-toggle {
		margin-top: -6px;
		font-size: 11px;
	}

	.toggle input {
		width: auto;
	}

	.queue-list {
		flex: 1 1 172px;
		min-height: 148px;
		margin-top: 2px;
		grid-template-rows: auto minmax(0, 1fr);
		overflow: hidden;
	}

	.queue-items {
		min-height: 0;
		overflow: auto;
		padding-right: 3px;
	}

	.queue-items p {
		display: block;
		box-sizing: border-box;
		min-height: 32px;
		margin: 0;
		overflow: hidden;
		padding: 7px 0;
		border-bottom: 1px solid var(--line);
		color: var(--ink);
		font-size: 13px;
		line-height: 18px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.queue-items p.active {
		color: var(--signal);
		font-weight: 700;
	}

	.queue-items .empty-note {
		color: var(--ink-dim);
		font-size: 11px;
	}

	.toast {
		position: fixed;
		right: 18px;
		bottom: 18px;
		max-width: min(520px, calc(100vw - 36px));
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: var(--ink);
		color: var(--paper);
		font-size: 12px;
	}

	.toast.error {
		background: var(--signal);
	}

	@media (max-width: 980px) {
		.studio-shell {
			height: auto;
			min-height: 100dvh;
			overflow: auto;
		}

		.studio-grid {
			grid-template-columns: 1fr;
			overflow: visible;
		}

		.facade p {
			max-width: 58vw;
		}

		.mixer-panel {
			gap: 12px;
		}

		.mic-button {
			min-height: clamp(104px, 16dvh, 136px);
		}

		.queue-list {
			flex: none;
			min-height: 0;
			overflow: visible;
		}

		.queue-items {
			overflow: visible;
		}

		.request-panel-body {
			grid-template-columns: 1fr;
		}
	}
</style>
