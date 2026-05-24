<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		FolderOpen,
		ListMusic,
		Mic,
		Radio,
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
		getTunnel,
		pickFolder,
		prepareLibrary,
		scanLibrary,
		skipBroadcast,
		startBroadcast,
		startTunnel,
		stopBroadcast,
		stopTunnel
	} from '../lib/api';
	import type { BroadcastStatus, LibraryState, NowPlaying, ServerConfig, Track, TunnelState } from '../lib/types';

	let config: ServerConfig | null = null;
	let library: LibraryState = { directory: '', tracks: [], preparing: false, lastScanAt: null };
	let status: BroadcastStatus | null = null;
	let tunnel: TunnelState = { running: false, url: null, startedAt: null, error: null };
	let directoryInput = '';
	let queue: Track[] = [];
	let nowPlaying: NowPlaying | null = null;
	let ordered = false;
	let errorMessage = '';
	let busyMessage = '';
	let outputLevel = 0.05;
	let musicVolume = 0.92;
	let micVolume = 0.92;
	let duckingDb = -12;
	let monitor = false;
	let micLatched = false;
	let pollTimer: number | undefined;
	const directPlayout = true;

	$: readyTracks = library.tracks.filter((track) => track.cacheReady);
	$: missingCount = library.tracks.filter((track) => !track.cacheReady).length;
	$: onAir = Boolean(status?.onAir);
	$: sourceConnected = Boolean(status?.sourceConnected);
	$: listenerUrl = tunnel.url ?? config?.listenerUrl ?? '';
	$: levelStyle = `--level: ${outputLevel.toFixed(3)};`;

	onMount(async () => {
		await refreshAll();
		pollTimer = window.setInterval(refreshStatusOnly, 2500);
	});

	onDestroy(() => {
		if (pollTimer) {
			window.clearInterval(pollTimer);
		}
	});

	async function refreshAll() {
		try {
			[config, library, status, tunnel, nowPlaying] = await Promise.all([
				getConfig(),
				getLibrary(),
				getStatus(),
				getTunnel(),
				getNowPlaying()
			]);
			directoryInput = library.directory;
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
			library = await scanLibrary(directoryInput);
			buildQueue();
		} catch (error) {
			setError(error);
		} finally {
			busyMessage = '';
		}
	}

	async function prepare() {
		errorMessage = '';
		busyMessage = 'Preparing radio copies';
		try {
			library = await prepareLibrary();
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
			busyMessage = 'Starting direct MP3 playout';
			status = await startBroadcast(queue.map((track) => track.id));
			nowPlaying = await getNowPlaying();
			outputLevel = 0.72;
		} catch (error) {
			await stopBroadcast();
			setError(error);
		} finally {
			busyMessage = '';
		}
	}

	async function goOffAir() {
		micLatched = false;
		status = await stopBroadcast();
		nowPlaying = null;
		outputLevel = 0.05;
	}

	async function skipTrack() {
		status = await skipBroadcast();
		window.setTimeout(() => {
			void getNowPlaying().then((program) => {
				nowPlaying = program;
			});
		}, 350);
	}

	function setMic(_open: boolean) {}

	function toggleLatch() {
		micLatched = !micLatched;
	}

	function applyAudioOptions() {}

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
				<span class:live={onAir} class:ready={!onAir && readyTracks.length > 0} class="status-dot"></span>
				{onAir ? 'ON AIR' : readyTracks.length > 0 ? 'READY' : 'OFF AIR'}
			</span>
			<span class="status-pill">
				<span class:ready={sourceConnected} class="status-dot"></span>
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
					<h2>Broadcast copies</h2>
				</div>
				<button class="icon-button" type="button" aria-label="Refresh" on:click={refreshAll}>
					<RefreshCw />
				</button>
			</div>

			<label class="field">
				<span>Music folder</span>
				<input bind:value={directoryInput} placeholder="C:\Music\saru2radio" />
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
				<button class="solid-button" type="button" disabled={library.preparing || library.tracks.length === 0} on:click={prepare}>
					<Radio />
					Prepare
				</button>
			</div>

			<div class="library-stats">
				<span>{library.tracks.length} tracks</span>
				<span>{readyTracks.length} ready</span>
				<span>{missingCount} pending</span>
			</div>

			<div class="track-list" aria-label="Track list">
				{#each library.tracks as track (track.id)}
					<div class:ready={track.cacheReady} class:error={Boolean(track.error)} class="track-row">
						<div>
							<strong>{track.title}</strong>
							<span>{track.artist}</span>
							{#if track.error}
								<em>{track.error}</em>
							{/if}
						</div>
						<time>{formatDuration(track.duration)}</time>
					</div>
				{/each}
				{#if library.tracks.length === 0}
					<p class="empty-note">Choose a folder and scan local audio files.</p>
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
				<button class="tool-button" type="button" on:click={() => { ordered = !ordered; buildQueue(); }}>
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
					class:latched={micLatched}
					class="mic-button"
					type="button"
					disabled={!onAir || directPlayout}
					on:mousedown={() => setMic(true)}
					on:mouseup={() => setMic(false)}
					on:mouseleave={() => setMic(false)}
					on:touchstart|preventDefault={() => setMic(true)}
					on:touchend|preventDefault={() => setMic(false)}
				>
					<Mic />
					Hold mic
				</button>
				<button class="tool-button" type="button" disabled={!onAir || directPlayout} on:click={toggleLatch}>
					{micLatched ? 'Unlatch' : 'Latch'}
				</button>
			</div>

			<label class="range">
				<span>Music</span>
				<input type="range" min="0" max="1.2" step="0.01" bind:value={musicVolume} disabled={directPlayout} on:input={applyAudioOptions} />
			</label>
			<label class="range">
				<span>Mic</span>
				<input type="range" min="0" max="1.4" step="0.01" bind:value={micVolume} disabled={directPlayout} on:input={applyAudioOptions} />
			</label>
			<label class="range">
				<span>Ducking {duckingDb} dB</span>
				<input type="range" min="-24" max="-3" step="1" bind:value={duckingDb} disabled={directPlayout} on:input={applyAudioOptions} />
			</label>
			<label class="toggle">
				<input type="checkbox" bind:checked={monitor} disabled={directPlayout} on:change={applyAudioOptions} />
				<span>Local monitor</span>
			</label>

			<div class="queue-list">
				<span class="eyebrow">queue</span>
				{#each queue.slice(0, 8) as track (track.id)}
					<p>{track.title}</p>
				{/each}
				{#if queue.length === 0}
					<p class="empty-note">Prepared songs appear here.</p>
				{/if}
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

	input {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.58);
		color: var(--ink);
		padding: 10px 11px;
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
		padding: 9px;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.35);
		opacity: 0.58;
	}

	.track-row.ready {
		opacity: 1;
	}

	.track-row.error {
		border-color: rgba(181, 31, 36, 0.42);
		opacity: 1;
	}

	.track-row strong,
	.track-row span,
	.track-row em,
	.queue-list p {
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
	}

	.mic-button {
		display: grid;
		width: 100%;
		aspect-ratio: 1 / 0.62;
		place-items: center;
		border-radius: 6px;
		background: var(--panel-dark);
		color: var(--paper);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.mic-button.latched {
		background: var(--signal);
	}

	.mic-button :global(svg) {
		width: 26px;
		height: 26px;
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

	.toggle input {
		width: auto;
	}

	.queue-list {
		max-height: min(34dvh, 260px);
		margin-top: auto;
		min-height: 0;
	}

	.queue-list p {
		margin: 0;
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
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
	}
</style>
