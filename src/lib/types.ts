export type BroadcastStatus = {
	onAir: boolean;
	streamUrl: string;
	stationName: string;
	startedAt: string | null;
	icecastUrl: string;
	listenerUrl: string;
	tunnelUrl: string | null;
	sourceConnected: boolean;
	activeListeners: number;
};

export type NowPlaying = {
	trackId: string | null;
	title: string;
	artist: string;
	startedAt: string | null;
	duration: number | null;
};

export type ListenerMessage = {
	id: string;
	name: string;
	message: string;
	receivedAt: string;
};

export type Track = {
	id: string;
	sourcePath: string;
	playPath: string;
	fileName: string;
	title: string;
	artist: string;
	duration: number | null;
	size: number;
	mtimeMs: number;
	cachePath: string;
	cacheReady: boolean;
	cacheStale: boolean;
	error?: string;
};

export type LibraryState = {
	directory: string;
	tracks: Track[];
	preparing: boolean;
	lastScanAt: string | null;
	recursive: boolean;
	sourceKind: 'empty' | 'ready-folder' | 'cache-manifest' | 'cache-tracks' | 'prepare-source';
};

export type StudioState = {
	broadcastDirectory: string;
	broadcastRecursive: boolean;
	ordered: boolean;
	prepDirectory: string;
	updatedAt: string | null;
};

export type ServerConfig = {
	stationName: string;
	studioUrl: string;
	listenerUrl: string;
	icecastUrl: string;
	mount: string;
	bitrateKbps: number;
	radioToolPath: string | null;
	cloudflaredAvailable: boolean;
};

export type TunnelState = {
	running: boolean;
	url: string | null;
	startedAt: string | null;
	error: string | null;
	mode: 'quick' | 'named' | null;
	hostname: string | null;
	configured: boolean;
};
