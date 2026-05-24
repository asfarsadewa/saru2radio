const PUBLIC_ORIGIN = 'https://saru2radio.com';
const TUNNEL_ORIGIN = 'https://origin.saru2radio.com';
const ORIGIN_TIMEOUT_MS = 5000;
const FALLBACK_STATUSES = new Set([502, 503, 504, 530]);

export default {
	async fetch(request) {
		const url = new URL(request.url);
		const originRequest = new Request(toOriginUrl(url), request);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), ORIGIN_TIMEOUT_MS);

		try {
			const response = await fetch(originRequest, { signal: controller.signal });
			if (!FALLBACK_STATUSES.has(response.status)) {
				if (url.pathname === '/status.json') {
					return publicStatusResponse(response);
				}
				if (url.pathname === '/live.mp3') {
					return publicStreamResponse(response);
				}
				return response;
			}

			response.body?.cancel();
			return offlineResponse(url);
		} catch {
			return offlineResponse(url);
		} finally {
			clearTimeout(timeout);
		}
	}
};

async function publicStatusResponse(response) {
	const status = await response.json();
	return jsonResponse({
		...status,
		streamUrl: `${PUBLIC_ORIGIN}/live.mp3`,
		icecastUrl: '',
		listenerUrl: PUBLIC_ORIGIN,
		tunnelUrl: status.tunnelUrl ? PUBLIC_ORIGIN : null
	});
}

function publicStreamResponse(response) {
	const headers = new Headers(response.headers);
	headers.set('content-type', 'audio/mpeg');
	headers.set('cache-control', 'no-store, no-transform');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

export function toOriginUrl(url) {
	const origin = new URL(TUNNEL_ORIGIN);
	origin.pathname = url.pathname;
	origin.search = url.search;
	return origin;
}

export function offlineResponse(url) {
	if (url.pathname === '/' || url.pathname === '/index.html') {
		return new Response(offlineHtml(), {
			status: 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store'
			}
		});
	}

	if (url.pathname === '/status.json') {
		return jsonResponse({
			onAir: false,
			streamUrl: `${PUBLIC_ORIGIN}/live.mp3`,
			stationName: 'saru2radio',
			startedAt: null,
			icecastUrl: '',
			listenerUrl: PUBLIC_ORIGIN,
			tunnelUrl: null,
			sourceConnected: false
		});
	}

	if (url.pathname === '/now-playing.json') {
		return jsonResponse({
			trackId: null,
			title: 'Off air',
			artist: 'saru2radio',
			startedAt: null,
			duration: null
		});
	}

	if (url.pathname === '/live.mp3') {
		return new Response('saru2radio is offline. The DJ has not opened the tunnel.', {
			status: 503,
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-store'
			}
		});
	}

	return new Response('Not found', {
		status: 404,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
}

function jsonResponse(body) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
}

function offlineHtml() {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>saru2radio - Off air</title>
	<style>
		:root {
			--paper: #f4f0e9;
			--panel: rgba(250, 247, 240, 0.9);
			--ink: #141311;
			--ink-dim: rgba(20, 19, 17, 0.66);
			--ink-faint: rgba(20, 19, 17, 0.42);
			--line: rgba(20, 19, 17, 0.18);
			--line-strong: rgba(20, 19, 17, 0.34);
			--signal: #b51f24;
			--amber: #d5a642;
			color: var(--ink);
			background: var(--paper);
			font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
			text-rendering: geometricPrecision;
		}
		* { box-sizing: border-box; }
		body {
			min-width: 320px;
			min-height: 100vh;
			margin: 0;
			display: grid;
			grid-template-rows: auto 1fr auto;
			padding: 18px;
			background:
				linear-gradient(90deg, rgba(20, 19, 17, 0.04) 1px, transparent 1px) 0 0 / 22px 22px,
				var(--paper);
		}
		header, footer {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 14px;
		}
		h1 {
			margin: 0;
			font-family: Georgia, serif;
			font-size: 32px;
			font-style: italic;
			font-weight: 400;
			line-height: 1;
		}
		.eyebrow {
			color: var(--ink-faint);
			font-size: 9px;
			font-weight: 700;
			letter-spacing: 0.16em;
			text-transform: uppercase;
		}
		.status {
			display: inline-flex;
			align-items: center;
			gap: 7px;
			min-height: 28px;
			padding: 6px 9px;
			border: 1px solid var(--line);
			border-radius: 3px;
			background: var(--panel);
			color: var(--ink-dim);
			font-size: 9px;
			font-weight: 700;
			letter-spacing: 0.14em;
			text-transform: uppercase;
		}
		.dot {
			width: 7px;
			height: 7px;
			border-radius: 50%;
			background: var(--signal);
			box-shadow: 0 0 0 3px rgba(181, 31, 36, 0.18);
		}
		main {
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
		}
		.band {
			display: grid;
			grid-template-columns: repeat(42, 1fr);
			align-items: end;
			gap: 5px;
			width: 100%;
			height: 86px;
			border-bottom: 1px solid var(--line-strong);
		}
		.band span {
			display: block;
			width: 1px;
			height: 26px;
			background: var(--ink-faint);
		}
		.band span:nth-child(7n + 1) {
			height: 58px;
			background: var(--ink);
		}
		.readout {
			display: flex;
			align-items: baseline;
			gap: 10px;
		}
		.readout strong {
			font-size: clamp(4.5rem, 18vw, 10rem);
			font-weight: 500;
			font-variant-numeric: tabular-nums;
			line-height: 0.85;
		}
		h2 {
			max-width: 14ch;
			margin: 8px auto 4px;
			text-align: center;
			font-family: Georgia, serif;
			font-size: clamp(2.2rem, 9vw, 5rem);
			font-style: italic;
			font-weight: 400;
			line-height: 0.92;
		}
		p, footer {
			color: var(--ink-dim);
			font-size: 12px;
			text-align: center;
		}
		footer {
			justify-content: center;
			min-height: 48px;
		}
	</style>
</head>
<body>
	<header>
		<div>
			<h1>saru2radio</h1>
			<span class="eyebrow">shortwave listener service</span>
		</div>
		<span class="status"><span class="dot"></span>OFF AIR</span>
	</header>
	<main>
		<div class="band" aria-hidden="true">${'<span></span>'.repeat(42)}</div>
		<div class="readout"><span class="eyebrow">tuned</span><strong>8.010</strong><span>MHz</span></div>
		<section>
			<span class="eyebrow">program</span>
			<h2>Off air</h2>
			<p>saru2radio</p>
		</section>
	</main>
	<footer>The station starts when the DJ opens the public tunnel.</footer>
</body>
</html>`;
}
