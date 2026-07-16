import type {
	AiDjAction,
	BroadcastQueueStatus,
	BroadcastStatus,
	LibraryState,
	ListenerMessage,
	NowPlaying,
	PreparationState,
	ServerConfig,
	StudioState,
	TunnelState
} from './types';

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			'content-type': 'application/json',
			...(init?.headers ?? {})
		}
	});

	if (!response.ok) {
		const message = await response.text();
		throw new Error(message || `Request failed: ${response.status}`);
	}

	return (await response.json()) as T;
}

export function getConfig(): Promise<ServerConfig> {
	return requestJson<ServerConfig>('/api/config');
}

export function getLibrary(): Promise<LibraryState> {
	return requestJson<LibraryState>('/api/library');
}

export function pickFolder(): Promise<{ directory: string }> {
	return requestJson<{ directory: string }>('/api/library/pick-folder', { method: 'POST' });
}

export function scanLibrary(directory: string, recursive = false): Promise<LibraryState> {
	return requestJson<LibraryState>('/api/library/scan', {
		method: 'POST',
		body: JSON.stringify({ directory, recursive })
	});
}

export function getStudioState(): Promise<StudioState> {
	return requestJson<StudioState>('/api/studio-state');
}

export function updateStudioState(patch: Partial<StudioState>): Promise<StudioState> {
	return requestJson<StudioState>('/api/studio-state', {
		method: 'PATCH',
		body: JSON.stringify(patch)
	});
}

export function getPreparation(): Promise<PreparationState> {
	return requestJson<PreparationState>('/api/preparation');
}

export function inspectPreparation(directory: string, recursive = false): Promise<PreparationState> {
	return requestJson<PreparationState>('/api/preparation/inspect', {
		method: 'POST',
		body: JSON.stringify({ directory, recursive })
	});
}

export function startPreparation(directory: string, recursive = false): Promise<PreparationState> {
	return requestJson<PreparationState>('/api/preparation/start', {
		method: 'POST',
		body: JSON.stringify({ directory, recursive })
	});
}

export function startBroadcast(trackIds?: string[]): Promise<BroadcastStatus> {
	return requestJson<BroadcastStatus>('/api/broadcast/start', {
		method: 'POST',
		body: JSON.stringify({ trackIds })
	});
}

export function playBroadcastNow(trackIds: string[]): Promise<BroadcastStatus> {
	return requestJson<BroadcastStatus>('/api/broadcast/play-now', {
		method: 'POST',
		body: JSON.stringify({ trackIds })
	});
}

export function updateBroadcastQueue(trackIds: string[]): Promise<BroadcastStatus> {
	return requestJson<BroadcastStatus>('/api/broadcast/queue', {
		method: 'POST',
		body: JSON.stringify({ trackIds })
	});
}

export function queueBroadcastNext(trackId: string): Promise<BroadcastQueueStatus> {
	return requestJson<BroadcastQueueStatus>('/api/broadcast/queue-next', {
		method: 'POST',
		body: JSON.stringify({ trackId })
	});
}

export function skipBroadcast(): Promise<BroadcastStatus> {
	return requestJson<BroadcastStatus>('/api/broadcast/skip', { method: 'POST' });
}

export function stopBroadcast(): Promise<BroadcastStatus> {
	return requestJson<BroadcastStatus>('/api/broadcast/stop', { method: 'POST' });
}

export function updateNowPlaying(payload: {
	trackId: string | null;
	title: string;
	artist: string;
	duration: number | null;
}): Promise<NowPlaying> {
	return requestJson<NowPlaying>('/api/now-playing', {
		method: 'POST',
		body: JSON.stringify(payload)
	});
}

export function getStatus(): Promise<BroadcastStatus> {
	return requestJson<BroadcastStatus>('/api/status');
}

export function getNowPlaying(): Promise<NowPlaying> {
	return requestJson<NowPlaying>('/api/now-playing');
}

export function getListenerMessages(): Promise<ListenerMessage[]> {
	return requestJson<ListenerMessage[]>('/api/listener-messages');
}

export function deleteListenerMessage(id: string): Promise<ListenerMessage[]> {
	return requestJson<ListenerMessage[]>(`/api/listener-messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function clearListenerMessages(): Promise<ListenerMessage[]> {
	return requestJson<ListenerMessage[]>('/api/listener-messages', { method: 'DELETE' });
}

export function getAiDjActions(): Promise<AiDjAction[]> {
	return requestJson<AiDjAction[]>('/api/ai-dj/actions');
}

export function clearAiDjActions(): Promise<AiDjAction[]> {
	return requestJson<AiDjAction[]>('/api/ai-dj/actions', { method: 'DELETE' });
}

export function startTunnel(): Promise<TunnelState> {
	return requestJson<TunnelState>('/api/tunnel/start', { method: 'POST' });
}

export function stopTunnel(): Promise<TunnelState> {
	return requestJson<TunnelState>('/api/tunnel/stop', { method: 'POST' });
}

export function getTunnel(): Promise<TunnelState> {
	return requestJson<TunnelState>('/api/tunnel');
}
