import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME_DIR = path.join(ROOT_DIR, '.saru2radio');
export const DIST_DIR = path.join(ROOT_DIR, 'dist');
export const TOOLS_DIR = path.join(ROOT_DIR, '.tools');
export const ICECAST_DIR = path.join(TOOLS_DIR, 'icecast');
export const ICECAST_EXE = path.join(ICECAST_DIR, 'bin', 'icecast.exe');
export const RADIO_SOUND_FALLBACK_EXE = path.resolve(
	ROOT_DIR,
	'..',
	'make-radio-sound',
	'dist',
	'make-radio-sound.exe'
);
