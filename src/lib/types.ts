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

export type AiDjDecision = 'play' | 'not_song_request' | 'song_unavailable' | 'ambiguous' | 'unsafe_ignore';

export type AiDjActionStatus =
	| 'analyzing'
	| 'played_now'
	| 'ignored_not_song'
	| 'ignored_unavailable'
	| 'ignored_ambiguous'
	| 'ignored_unsafe'
	| 'log_only_mode'
	| 'disabled'
	| 'failed';

export type AiDjAction = {
	id: string;
	requestId: string;
	listenerName: string;
	requestMessage: string;
	receivedAt: string;
	updatedAt: string;
	status: AiDjActionStatus;
	decision?: AiDjDecision;
	confidence?: number;
	matchedTrackId?: string;
	matchedTrackTitle?: string;
	matchedTrackArtist?: string;
	reason: string;
	model: string;
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
	aiDj: AiDjConfig;
};

export type AiDjConfig = {
	enabled: boolean;
	configured: boolean;
	model: string;
	minConfidence: number;
	status: 'ready' | 'missing-key' | 'disabled';
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
