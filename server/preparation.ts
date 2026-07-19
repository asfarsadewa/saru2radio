import type { PreparationState } from '../src/lib/types.js';
import path from 'node:path';
import {
	LibraryManager,
	preparationSourceDirectoryError,
	type PrepareProgress,
	type ScanOptions
} from './library.js';

type LibraryFactory = () => LibraryManager;

export type PreparationStartOptions = ScanOptions & {
	missingOnly?: boolean;
};

const ACTIVE_PHASES = new Set<PreparationState['phase']>(['scanning', 'preparing']);

export class PreparationBusyError extends Error {}

export class PreparationManager {
	private state: PreparationState;
	private activeJob: Promise<void> | null = null;

	constructor(
		private readonly radioToolPath: string | null,
		private readonly createLibrary: LibraryFactory = () => new LibraryManager(radioToolPath)
	) {
		this.state = emptyPreparationState(Boolean(radioToolPath));
	}

	getState(): PreparationState {
		return structuredClone(this.state);
	}

	isActive(): boolean {
		return ACTIVE_PHASES.has(this.state.phase);
	}

	async inspect(directory: string, options: ScanOptions = {}): Promise<PreparationState> {
		this.assertIdle();
		const recursive = options.recursive ?? false;
		const sourceDirectoryError = preparationSourceDirectoryError(directory);
		if (sourceDirectoryError) {
			this.state = {
				...emptyPreparationState(Boolean(this.radioToolPath)),
				phase: 'ready',
				directory: path.resolve(directory),
				recursive,
				updatedAt: new Date().toISOString(),
				error: sourceDirectoryError
			};
			return this.getState();
		}
		this.state = {
			...emptyPreparationState(Boolean(this.radioToolPath)),
			phase: 'scanning',
			directory,
			recursive,
			updatedAt: new Date().toISOString()
		};

		try {
			const scanned = await this.createLibrary().scan(directory, { recursive });
			this.state = inspectedState(scanned, Boolean(this.radioToolPath));
			return this.getState();
		} catch (error) {
			this.fail(error);
			throw error;
		}
	}

	start(directory: string, options: PreparationStartOptions = {}): PreparationState {
		this.assertIdle();
		if (!this.radioToolPath) {
			throw new Error('make-radio-sound.exe was not found. Run `bun run setup:radio-sound` or set RADIO_SOUND_EXE.');
		}
		const sourceDirectoryError = preparationSourceDirectoryError(directory);
		if (sourceDirectoryError) {
			throw new Error(sourceDirectoryError);
		}

		const now = new Date().toISOString();
		this.state = {
			...emptyPreparationState(true),
			phase: 'scanning',
			scope: options.missingOnly ? 'missing-only' : 'all',
			directory,
			recursive: options.recursive ?? false,
			startedAt: now,
			updatedAt: now
		};
		this.activeJob = this.run(directory, options).finally(() => {
			this.activeJob = null;
		});
		return this.getState();
	}

	async waitForCompletion(): Promise<PreparationState> {
		await this.activeJob;
		return this.getState();
	}

	private async run(directory: string, options: PreparationStartOptions): Promise<void> {
		try {
			const manager = this.createLibrary();
			const scanned = await manager.scan(directory, { recursive: options.recursive ?? false });
			const inspected = inspectedState(scanned, true);
			const selectedTrackIds = options.missingOnly
				? scanned.tracks
						.filter((track) => !track.cacheReady && !track.cacheStale)
						.map((track) => track.id)
				: undefined;
			this.state = {
				...inspected,
				phase: 'preparing',
				scope: options.missingOnly ? 'missing-only' : 'all',
				targetTotal: selectedTrackIds?.length ?? scanned.tracks.length,
				deferred: options.missingOnly ? inspected.stale : 0,
				startedAt: this.state.startedAt,
				updatedAt: new Date().toISOString()
			};

			const prepared = await manager.prepare(selectedTrackIds, {
				continueOnError: true,
				onProgress: (progress) => this.updateProgress(progress)
			});
			const ready = prepared.tracks.filter((track) => track.cacheReady).length;
			const stale = prepared.tracks.filter((track) => track.cacheStale).length;
			this.state = {
				...this.state,
				phase: 'completed',
				ready,
				pending: prepared.tracks.length - ready,
				stale,
				deferred: options.missingOnly ? stale : 0,
				currentTrack: null,
				finishedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			};
		} catch (error) {
			this.fail(error);
		}
	}

	private updateProgress(progress: PrepareProgress): void {
		const updatedAt = new Date().toISOString();
		if (progress.type === 'start') {
			this.state = {
				...this.state,
				currentTrack: {
					trackId: progress.track.id,
					fileName: progress.track.fileName,
					index: progress.index,
					total: progress.total
				},
				updatedAt
			};
			return;
		}

		if (progress.type === 'skip') {
			this.state = {
				...this.state,
				completed: this.state.completed + 1,
				skipped: this.state.skipped + 1,
				currentTrack: null,
				updatedAt
			};
			return;
		}

		if (progress.type === 'success') {
			this.state = {
				...this.state,
				ready: this.state.ready + 1,
				pending: Math.max(0, this.state.pending - 1),
				completed: this.state.completed + 1,
				converted: this.state.converted + 1,
				currentTrack: null,
				updatedAt
			};
			return;
		}

		const message = progress.message ?? 'Could not convert track.';
		this.state = {
			...this.state,
			completed: this.state.completed + 1,
			failed: this.state.failed + 1,
			currentTrack: null,
			failures: [
				...this.state.failures,
				{
					trackId: progress.track.id,
					fileName: progress.track.fileName,
					message
				}
			],
			updatedAt
		};
	}

	private assertIdle(): void {
		if (this.isActive()) {
			throw new PreparationBusyError('Radio-copy preparation is already running.');
		}
	}

	private fail(error: unknown): void {
		const now = new Date().toISOString();
		this.state = {
			...this.state,
			phase: 'error',
			currentTrack: null,
			finishedAt: now,
			updatedAt: now,
			error: error instanceof Error ? error.message : 'Radio-copy preparation failed.'
		};
	}
}

function emptyPreparationState(toolAvailable: boolean): PreparationState {
	return {
		phase: 'idle',
		scope: 'all',
		directory: '',
		recursive: false,
		toolAvailable,
		total: 0,
		targetTotal: 0,
		ready: 0,
		pending: 0,
		stale: 0,
		deferred: 0,
		completed: 0,
		converted: 0,
		skipped: 0,
		failed: 0,
		currentTrack: null,
		failures: [],
		startedAt: null,
		finishedAt: null,
		updatedAt: null,
		error: null
	};
}

function inspectedState(
	library: Awaited<ReturnType<LibraryManager['scan']>>,
	toolAvailable: boolean
): PreparationState {
	const ready = library.tracks.filter((track) => track.cacheReady).length;
	return {
		...emptyPreparationState(toolAvailable),
		phase: 'ready',
		directory: library.directory,
		recursive: library.recursive,
		total: library.tracks.length,
		ready,
		pending: library.tracks.length - ready,
		stale: library.tracks.filter((track) => track.cacheStale).length,
		updatedAt: new Date().toISOString()
	};
}
