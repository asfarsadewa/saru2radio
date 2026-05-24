<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Pause, Play, Radio } from '@lucide/svelte';
	import type { BroadcastStatus, NowPlaying } from '../lib/types';

	let status: BroadcastStatus | null = null;
	let nowPlaying: NowPlaying | null = null;
	let audio: HTMLAudioElement;
	let playing = false;
	let errorMessage = '';
	let pollTimer: number | undefined;

	$: onAir = Boolean(status?.onAir);

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
</script>

<main class="listener-shell">
	<header class="listener-header">
		<div>
			<h1 class="wordmark">saru2radio</h1>
			<span class="eyebrow">temporary shortwave service</span>
		</div>
		<span class="status-pill">
			<span class:live={onAir} class="status-dot"></span>
			{onAir ? 'ON AIR' : 'OFF AIR'}
		</span>
	</header>

	<section class="receiver">
		<div class="dial-band" aria-hidden="true">
			{#each Array.from({ length: 42 }) as _, index}
				<span class:major={index % 7 === 0}></span>
			{/each}
		</div>
		<div class="frequency-readout">
			<span class="eyebrow">tuned</span>
			<strong>8.010</strong>
			<span>MHz</span>
		</div>
		<button class:playing class="play-control" type="button" disabled={!onAir} on:click={togglePlay}>
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
	</section>

	<footer>
		<Radio />
		<span>{errorMessage || (onAir ? 'Live from the local booth.' : 'The station starts when the DJ goes on air.')}</span>
	</footer>

	<audio bind:this={audio} on:pause={() => (playing = false)} on:ended={() => (playing = false)}></audio>
</main>

<style>
	.listener-shell {
		min-height: 100dvh;
		display: grid;
		grid-template-rows: auto 1fr auto;
		padding: 18px;
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

	.receiver {
		width: min(100%, 760px);
		place-self: center;
		display: grid;
		gap: 24px;
		justify-items: center;
		padding: clamp(22px, 6vw, 54px);
		border: 1px solid var(--line);
		border-radius: 6px;
		background:
			radial-gradient(circle at 50% 12%, rgba(213, 166, 66, 0.2), transparent 36%),
			var(--panel);
		backdrop-filter: blur(18px);
	}

	.dial-band {
		display: grid;
		grid-template-columns: repeat(42, 1fr);
		align-items: end;
		gap: 5px;
		width: 100%;
		height: 86px;
		border-bottom: 1px solid var(--line-strong);
	}

	.dial-band span {
		display: block;
		height: 26px;
		width: 1px;
		background: var(--ink-faint);
	}

	.dial-band span.major {
		height: 58px;
		background: var(--ink);
	}

	.frequency-readout {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	.frequency-readout strong {
		font-size: clamp(4.5rem, 18vw, 10rem);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		line-height: 0.85;
	}

	.play-control {
		display: grid;
		width: 92px;
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
		width: 30px;
		height: 30px;
	}

	.program {
		text-align: center;
	}

	.program h2 {
		max-width: 14ch;
		margin: 8px auto 4px;
		font-family: var(--serif);
		font-size: clamp(2.2rem, 9vw, 5rem);
		font-style: italic;
		font-weight: 400;
		line-height: 0.92;
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
		height: 34px;
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
		min-height: 48px;
	}

	footer :global(svg) {
		width: 16px;
		height: 16px;
	}

	@keyframes meter {
		from {
			height: 8px;
		}
		to {
			height: 34px;
		}
	}
</style>
