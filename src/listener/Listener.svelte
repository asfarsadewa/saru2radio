<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Pause, Play, Radio, Send } from '@lucide/svelte';
	import type { BroadcastStatus, NowPlaying } from '../lib/types';

	let status: BroadcastStatus | null = null;
	let nowPlaying: NowPlaying | null = null;
	let audio: HTMLAudioElement;
	let playing = false;
	let errorMessage = '';
	let requestName = '';
	let requestMessage = '';
	let requestStatus = '';
	let requestSending = false;
	let pollTimer: number | undefined;

	$: onAir = Boolean(status?.onAir);
	$: requestDisabled = !onAir || requestSending;
	$: requestCharacters = requestMessage.length;

	onMount(async () => {
		await refresh();
		pollTimer = window.setInterval(refresh, 3500);
	});

	onDestroy(() => {
		if (pollTimer) {
			window.clearInterval(pollTimer);
		}
	});

	async function refresh() {
		try {
			const [statusResponse, nowResponse] = await Promise.all([
				fetch('/status.json', { cache: 'no-store' }),
				fetch('/now-playing.json', { cache: 'no-store' })
			]);
			status = (await statusResponse.json()) as BroadcastStatus;
			nowPlaying = (await nowResponse.json()) as NowPlaying;
		} catch {
			errorMessage = 'Could not reach saru2radio.';
		}
	}

	async function togglePlay() {
		errorMessage = '';
		if (!onAir) {
			return;
		}

		try {
			if (playing) {
				audio.pause();
			} else {
				audio.src = `${status?.streamUrl ?? '/live.mp3'}?t=${Date.now()}`;
				await audio.play();
			}
			playing = !playing;
		} catch {
			errorMessage = 'The live stream is not ready yet.';
		}
	}

	async function sendRequest() {
		requestStatus = '';
		if (!onAir || requestSending) {
			return;
		}

		const name = requestName.trim();
		const message = requestMessage.trim();
		if (!name || !message) {
			requestStatus = 'Name and message are required.';
			return;
		}

		requestSending = true;
		try {
			const response = await fetch('/requests', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name, message })
			});

			if (!response.ok) {
				throw new Error((await response.text()) || 'Could not send request.');
			}

			requestName = name;
			requestMessage = '';
			requestStatus = 'Request sent to the booth.';
		} catch (error) {
			requestStatus = error instanceof Error ? error.message : 'Could not send request.';
		} finally {
			requestSending = false;
		}
	}
</script>

<main class="listener-shell">
	<header class="listener-header">
		<div>
			<h1 class="wordmark">saru2radio</h1>
			<span class="eyebrow">shortwave listener service</span>
		</div>
		<span class="status-pill">
			<span class:live={onAir} class:offline={!onAir} class="status-dot"></span>
			{onAir ? 'ON AIR' : 'OFF AIR'}
		</span>
	</header>

	<section class="listener-console">
		<section class="receiver" aria-label="Live receiver">
			<div class="dial-band" aria-hidden="true">
				{#each Array.from({ length: 42 }) as _, index}
					<span class:major={index % 7 === 0}></span>
				{/each}
			</div>
			<div class="receiver-main">
				<button class:playing class="play-control" type="button" disabled={!onAir} aria-label={playing ? 'Pause stream' : 'Play stream'} on:click={togglePlay}>
					{#if playing}
						<Pause />
					{:else}
						<Play />
					{/if}
				</button>
				<div class="program">
					<span class="eyebrow">program</span>
					<h2>{nowPlaying?.title ?? 'Off air'}</h2>
					<p>{nowPlaying?.artist ?? 'saru2radio'}</p>
				</div>
				<div class:active={playing} class="signal-lines" aria-hidden="true">
					<span></span><span></span><span></span><span></span><span></span>
				</div>
			</div>
		</section>

		<form class="request-line" on:submit|preventDefault={sendRequest}>
			<div class="request-head">
				<span class="eyebrow">request line</span>
				<span>{requestCharacters}/500</span>
			</div>
			<div class="request-fields">
				<input bind:value={requestName} disabled={requestDisabled} maxlength="40" placeholder="Your name" aria-label="Your name" />
				<textarea
					bind:value={requestMessage}
					disabled={requestDisabled}
					maxlength="500"
					placeholder="Song request or message"
					aria-label="Song request or message"
					rows="2"
				></textarea>
				<button class="send-request" type="submit" disabled={requestDisabled}>
					<Send />
					{requestSending ? 'Sending' : 'Send'}
				</button>
			</div>
			<p>{requestStatus || (onAir ? 'Requests go straight to the DJ booth.' : 'Requests open when the station is on air.')}</p>
		</form>
	</section>

	<footer>
		<Radio />
		<span>{errorMessage || (onAir ? 'Live from the local booth.' : 'The station starts when the DJ goes on air.')}</span>
	</footer>

	<audio bind:this={audio} on:pause={() => (playing = false)} on:ended={() => (playing = false)}></audio>
</main>

<style>
	.listener-shell {
		height: 100dvh;
		min-height: 0;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		gap: 12px;
		overflow: hidden;
		padding: clamp(12px, 2vw, 18px);
		background:
			linear-gradient(90deg, rgba(20, 19, 17, 0.04) 1px, transparent 1px) 0 0 / 22px 22px,
			var(--paper);
	}

	.listener-header,
	footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
	}

	.listener-console {
		width: min(100%, 820px);
		min-height: 0;
		place-self: center;
		display: grid;
		grid-template-rows: auto auto;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 6px;
		background:
			radial-gradient(circle at 50% 12%, rgba(213, 166, 66, 0.2), transparent 36%),
			var(--panel);
		backdrop-filter: blur(18px);
	}

	.receiver {
		display: grid;
		gap: 14px;
		padding: clamp(16px, 4vw, 30px) clamp(16px, 5vw, 42px) 14px;
	}

	.receiver-main {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: clamp(14px, 3vw, 24px);
	}

	.request-line {
		display: grid;
		gap: 9px;
		padding: 14px clamp(16px, 5vw, 42px) 16px;
		border-top: 1px solid var(--line);
		background: rgba(255, 255, 255, 0.18);
	}

	.request-head,
	.request-fields {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.request-head {
		justify-content: space-between;
		color: var(--ink-faint);
		font-size: 10px;
	}

	.request-fields {
		display: grid;
		grid-template-columns: minmax(118px, 0.36fr) minmax(0, 1fr) auto;
		align-items: stretch;
	}

	.request-line input,
	.request-line textarea {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.58);
		color: var(--ink);
		font: inherit;
		padding: 10px 11px;
	}

	.request-line input {
		min-width: 0;
	}

	.request-line textarea {
		min-height: 54px;
		resize: none;
	}

	.request-line p {
		margin: 0;
		color: var(--ink-dim);
		font-size: 11px;
	}

	.send-request {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-width: 104px;
		min-height: 54px;
		border-radius: 4px;
		background: var(--ink);
		color: var(--paper);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.send-request :global(svg) {
		width: 16px;
		height: 16px;
	}

	.dial-band {
		display: grid;
		grid-template-columns: repeat(42, 1fr);
		align-items: end;
		gap: 4px;
		width: 100%;
		height: 48px;
		border-bottom: 1px solid var(--line-strong);
	}

	.dial-band span {
		display: block;
		height: 14px;
		width: 1px;
		background: var(--ink-faint);
	}

	.dial-band span.major {
		height: 34px;
		background: var(--ink);
	}

	.play-control {
		display: grid;
		width: clamp(62px, 9vw, 78px);
		aspect-ratio: 1;
		place-items: center;
		border-radius: 50%;
		background: var(--ink);
		color: var(--paper);
		box-shadow: 0 28px 50px -30px rgba(20, 19, 17, 0.7);
	}

	.play-control.playing {
		background: var(--signal);
	}

	.play-control :global(svg) {
		width: 26px;
		height: 26px;
	}

	.program {
		min-width: 0;
		text-align: left;
	}

	.program h2 {
		max-width: 26ch;
		margin: 5px 0 4px;
		font-family: var(--serif);
		font-size: clamp(2rem, 6vw, 4.25rem);
		font-style: italic;
		font-weight: 400;
		line-height: 0.96;
		overflow-wrap: anywhere;
	}

	.program p,
	footer {
		color: var(--ink-dim);
		font-size: 12px;
	}

	.signal-lines {
		display: flex;
		align-items: center;
		gap: 5px;
		height: 32px;
	}

	.signal-lines span {
		width: 4px;
		height: 8px;
		border-radius: 2px;
		background: var(--signal);
		opacity: 0.28;
	}

	.signal-lines.active span {
		animation: meter 720ms ease-in-out infinite alternate;
		opacity: 0.78;
	}

	.signal-lines span:nth-child(2) {
		animation-delay: 90ms;
	}

	.signal-lines span:nth-child(3) {
		animation-delay: 180ms;
	}

	.signal-lines span:nth-child(4) {
		animation-delay: 270ms;
	}

	.signal-lines span:nth-child(5) {
		animation-delay: 360ms;
	}

	footer {
		justify-content: center;
		min-height: 34px;
	}

	footer :global(svg) {
		width: 16px;
		height: 16px;
	}

	@media (max-width: 680px) {
		.listener-header {
			align-items: flex-start;
		}

		.receiver {
			gap: 12px;
			padding: 14px 14px 12px;
		}

		.receiver-main {
			grid-template-columns: auto minmax(0, 1fr);
			gap: 12px;
		}

		.play-control {
			width: 58px;
		}

		.program h2 {
			font-size: clamp(1.75rem, 8vw, 3rem);
		}

		.signal-lines {
			grid-column: 1 / -1;
			justify-content: center;
			height: 22px;
		}

		.signal-lines.active span {
			animation-name: meter-small;
		}

		.request-line {
			padding: 12px 14px 14px;
		}

		.request-fields {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
		}

		.request-line input {
			grid-column: 1 / -1;
		}

		.send-request {
			min-width: 86px;
			min-height: 50px;
		}
	}

	@media (max-height: 680px) {
		.listener-shell {
			gap: 8px;
			padding-block: 10px;
		}

		.receiver {
			gap: 10px;
			padding-block: 12px;
		}

		.dial-band {
			height: 34px;
		}

		.dial-band span {
			height: 10px;
		}

		.dial-band span.major {
			height: 24px;
		}

		.program h2 {
			font-size: clamp(1.7rem, 5vw, 3.1rem);
		}

		.request-line textarea {
			min-height: 46px;
		}

		.send-request {
			min-height: 46px;
		}

		footer {
			min-height: 26px;
		}
	}

	@keyframes meter {
		from {
			height: 8px;
		}
		to {
			height: 34px;
		}
	}

	@keyframes meter-small {
		from {
			height: 6px;
		}
		to {
			height: 22px;
		}
	}
</style>
