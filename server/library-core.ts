import crypto from 'node:crypto';
import path from 'node:path';

export const SUPPORTED_AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.mp4', '.wav', '.flac', '.ogg', '.aac']);
export const RADIO_PRESET = {
	mode: 'sw',
	intensity: 0.7,
	format: 'mp3'
} as const;

export type CacheFingerprint = {
	sourcePath: string;
	size: number;
	mtimeMs: number;
	preset: string;
};

export function isSupportedAudio(filePath: string): boolean {
	return SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function createTrackId(sourcePath: string): string {
	return crypto.createHash('sha1').update(path.resolve(sourcePath).toLowerCase()).digest('hex').slice(0, 16);
}

export function stableTrackSeed(sourcePath: string): number {
	return crypto.createHash('sha1').update(path.resolve(sourcePath).toLowerCase()).digest().readUInt32BE(0);
}

export function radioPresetKey(): string {
	return `${RADIO_PRESET.mode}-${RADIO_PRESET.intensity}-${RADIO_PRESET.format}`;
}

export function cacheFileName(sourcePath: string): string {
	return `${createTrackId(sourcePath)}.radio.mp3`;
}

export function isCacheFresh(
	entry: CacheFingerprint | undefined,
	source: { sourcePath: string; size: number; mtimeMs: number },
	preset = radioPresetKey()
): boolean {
	if (!entry) {
		return false;
	}

	return (
		path.resolve(entry.sourcePath).toLowerCase() === path.resolve(source.sourcePath).toLowerCase() &&
		entry.size === source.size &&
		Math.abs(entry.mtimeMs - source.mtimeMs) < 1 &&
		entry.preset === preset
	);
}
