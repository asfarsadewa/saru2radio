<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		FolderOpen,
		ListMusic,
		Mic,
		RefreshCw,
		Shuffle,
		SkipForward,
		StopCircle,
		TowerControl,
		UploadCloud,
		Volume2
	} from '@lucide/svelte';
	import {
		getConfig,
		getLibrary,
		getNowPlaying,
		getStatus,
		getStudioState,
		getTunnel,
		pickFolder,
		scanLibrary,
		startTunnel,
		stopBroadcast,
		stopTunnel,
		updateNowPlaying,
		updateStudioState
	} from '../lib/api';
	import { StudioEngine, type MicCaptureState, type MicColorMode } from '../lib/audio/studioEngine';
	import type { BroadcastStatus, LibraryState, NowPlaying, ServerConfig, Track, TunnelState } from '../lib/types';

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
	let micLatched = false;
	let micHeld = false;
	let micOpen = false;
	let micReady = false;
	let pollTimer: number | undefined;
	const engine = new StudioEngine();

	$: readyTracks = library.tracks.filter((track) => track.cacheReady);
	$: missingCount = library.tracks.filter((track) => !track.cacheReady).length;
	$: onAir = Boolean(status?.onAir);
	$: sourceConnected = Boolean(status?.sourceConnected);
	$: listenerUrl = tunnel.url ?? config?.listenerUrl ?? '';
	$: levelStyle = `--level: ${outputLevel.toFixed(3)};`;
	$: micOpen = micHeld || micLatched;
	$: micLevelStyle = `--mic-level: ${micLevel.toFixed(3)};`;
	$: micButtonLabel = micOpen ? (micReady && !micMuted ? 'Mic open' : 'No mic') : 'Hold mic';
	$: micStatusLabel = micReady ? (micMuted ? 'MIC MUTED' : 'MIC READY') : 'MIC NOT CONNECTED';
	$: micDetail = micMessage || micLabel || 'Choose an input, then go on air.';

	onMount(async () => {
		await refreshAll();
		await refreshMicrophones();
		pollTimer = window.setInterval(refreshStatusOnly, 2500);
	});

	onDestroy(() => {
		if (pollTimer) {
			window.clearInterval(pollTimer);
		}
		void engine.stop();
	});

	async function refreshAll() {
		try {
			const [nextConfig, nextLibrary, nextStatus, nextTunnel, nextNowPlaying, studioState] = await Promise.all([
				getConfig(),
				getLibrary(),
				getStatus(),
				getTunnel(),
				getNowPlaying(),
				getStudioState()
			]);
			config = nextConfig;
			library = nextLibrary;
			status = nextStatus;
			tunnel = nextTunnel;
			nowPlaying = nextNowPlaying;
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
			[status, tunnel, nowPlaying] = await Promise.all([getStatus(), getTunnel(), getNowPlaying()]);
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
		} catch (error) {
			setError(error);
		} finally {
			busyMessage = '';
		}
	}

	function buildQueue() {
		const tracks = [...readyTracks];
		queue = ordered ? tracks : shuffleTracks(tracks);
		if (onAir && queue.length > 0) {
			engine.setQueue(queue);
		}
	}

	async function goOnAir() {
		if (!config) {
			return;
		}
		errorMessage = '';
		busyMessage = 'Checking radio copies';
		try {
			library = await getLibrary();
		} catch (error) {
			busyMessage = '';
			setError(error);
			return;
		}
		buildQueue();
		if (queue.length === 0) {
			busyMessage = '';
			errorMessage = 'Prepare at least one radio copy before going on air.';
			return;
		}

		try {
			busyMessage = 'Starting live mixer';
			await engine.start(queue, getEngineOptions(), {
				onTrack: handleTrackChange,
				onLevel: (level) => {
					outputLevel = level;
				},
				onMicLevel: (level) => {
					micLevel = level;
				},
				onMicState: (state) => {
					applyMicCaptureState(state);
				},
				onError: (message) => {
					errorMessage = message;
				},
				onSourceState: (connected) => {
					if (status) {
						status = { ...status, sourceConnected: connected };
					}
				}
			});
			status = await getStatus();
			nowPlaying = await getNowPlaying();
			await refreshMicrophones();
			outputLevel = 0.72;
		} catch (error) {
			await engine.stop();
			await stopBroadcast();
			setError(error);
		} finally {
			busyMessage = '';
		}
	}

	async function goOffAir() {
		await engine.stop();
		micLatched = false;
		micHeld = false;
		micReady = false;
		micLevel = 0;
		micLabel = '';
		micMessage = '';
		micMuted = false;
		status = await stopBroadcast();
		nowPlaying = null;
		outputLevel = 0.05;
	}

	function skipTrack() {
		engine.skip();
	}

	function setMic(open: boolean) {
		micHeld = open;
		applyMicState();
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

	function toggleLatch() {
		micLatched = !micLatched;
		applyMicState();
	}

	function applyAudioOptions() {
		engine.setOptions(getEngineOptions());
	}

	async function retryMic() {
		errorMessage = '';
		try {
			await engine.retryMicrophone();
			await refreshMicrophones();
		} catch (error) {
			setError(error);
		}
	}

	async function changeMicDevice() {
		errorMessage = '';
		try {
			await engine.selectMicrophone(selectedMicId);
			await refreshMicrophones();
		} catch (error) {
			setError(error);
		}
	}

	function applyMicState() {
		engine.setMicOpen(micHeld || micLatched);
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
		if (onAir) {
			try {
				await engine.playNow(track);
			} catch (error) {
				setError(error);
			}
			return;
		}
		queue = [track, ...readyTracks.filter((candidate) => candidate.id !== track.id)];
	}

	async function toggleOrderMode() {
		ordered = !ordered;
		buildQueue();
		await updateStudioState({ ordered });
	}

	function getEngineOptions() {
		return {
			bitrateKbps: config?.bitrateKbps ?? 64,
			musicVolume: Number(musicVolume),
			micVolume: Number(micVolume),
			micDeviceId: selectedMicId,
			micColor,
			duckingDb: Number(duckingDb),
			monitor
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

	function setError(error: unknown) {
		errorMessage = error instanceof Error ? error.message : 'Unexpected error.';
	}

	function shuffleTracks(tracks: Track[]): Track[] {
		const copy = [...tracks];
		for (let index = copy.length - 1; index > 0; index -= 1) {
			const next = Math.floor(Math.random() * (index + 1));
			[copy[index], copy[next]] = [copy[next], copy[index]];
		}
		return copy;
	}

	function formatDuration(seconds: number | null): string {
		if (!seconds || !Number.isFinite(seconds)) {
			return '--:--';
		}
		const minutes = Math.floor(seconds / 60);
		const rest = Math.floor(seconds % 60).toString().padStart(2, '0');
		return `${minutes}:${rest}`;
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
						disabled={!track.cacheReady}
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
				<button class:live={onAir} class="broadcast-button" type="button" on:click={onAir ? goOffAir : goOnAir}>
					{#if onAir}
						<StopCircle />
						OFF AIR
					{:else}
						<TowerControl />
						ON AIR
					{/if}
				</button>
				<button class="icon-button" type="button" disabled={!onAir} aria-label="Skip track" on:click={skipTrack}>
					<SkipForward />
				</button>
				<button class="tool-button" type="button" on:click={toggleOrderMode}>
					<Shuffle />
					{ordered ? 'Ordered' : 'Shuffle'}
				</button>
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
					disabled={!onAir}
					on:pointerdown={beginMicHold}
					on:pointerup={endMicHold}
					on:pointercancel={endMicHold}
				>
					<Mic />
					{micButtonLabel}
				</button>
				<button class="tool-button" type="button" disabled={!onAir} on:click={toggleLatch}>
					{micLatched ? 'Unlatch' : 'Latch'}
				</button>
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
				<input type="range" min="0" max="1.2" step="0.01" bind:value={musicVolume} on:input={applyAudioOptions} />
			</label>
			<label class="range">
				<span>Mic</span>
				<input type="range" min="0" max="1.4" step="0.01" bind:value={micVolume} on:input={applyAudioOptions} />
			</label>
			<label class="range">
				<span>Ducking {duckingDb} dB</span>
				<input type="range" min="-24" max="-3" step="1" bind:value={duckingDb} on:input={applyAudioOptions} />
			</label>
			<label class="toggle">
				<input type="checkbox" bind:checked={monitor} on:change={applyAudioOptions} />
				<span>Local monitor</span>
			</label>

			<div class="queue-list">
				<span class="eyebrow">queue</span>
				<div class="queue-items">
					{#each queue.slice(0, 8) as track (track.id)}
						<p>{track.title}</p>
					{/each}
					{#if queue.length === 0}
						<p class="empty-note">Prepared songs appear here.</p>
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
		grid-template-rows: 1fr auto auto;
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
		grid-template-rows: auto 1fr auto;
		min-height: 0;
		padding: 20px;
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
		font-size: clamp(2.2rem, 6vw, 5.5rem);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0;
	}

	.vu {
		position: relative;
		align-self: center;
		width: min(100%, 540px);
		aspect-ratio: 2.6 / 1;
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
		height: 95%;
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

	.now h2 {
		margin: 6px 0;
		font-family: var(--serif);
		font-size: clamp(2rem, 5vw, 4.5rem);
		font-style: italic;
		font-weight: 400;
		line-height: 0.95;
		letter-spacing: 0;
	}

	.transport,
	.facade {
		justify-content: space-between;
		gap: 10px;
		padding: 10px;
	}

	.broadcast-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		min-height: 58px;
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

	.facade p {
		max-width: 38vw;
		margin: 4px 0 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
	}
</style>
