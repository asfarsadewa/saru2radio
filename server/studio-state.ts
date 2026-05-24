import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StudioState } from '../src/lib/types.js';
import { RUNTIME_DIR } from './paths.js';

const STATE_PATH = path.join(RUNTIME_DIR, 'studio-state.json');

type PersistedStudioState = Partial<StudioState> & {
	version?: 1;
};

const DEFAULT_STATE: StudioState = {
	broadcastDirectory: '',
	broadcastRecursive: false,
	ordered: false,
	prepDirectory: '',
	updatedAt: null
};

export class StudioStateStore {
	private state: StudioState = { ...DEFAULT_STATE };

	constructor(private readonly statePath = STATE_PATH) {}

	async load(): Promise<StudioState> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as PersistedStudioState;
			this.state = normalizeState(parsed);
		} catch {
			this.state = { ...DEFAULT_STATE };
		}
		return this.get();
	}

	get(): StudioState {
		return { ...this.state };
	}

	async update(patch: Partial<StudioState>): Promise<StudioState> {
		this.state = normalizeState({
			...this.state,
			...patch,
			updatedAt: new Date().toISOString()
		});
		await fs.mkdir(path.dirname(this.statePath), { recursive: true });
		await fs.writeFile(this.statePath, `${JSON.stringify({ version: 1, ...this.state }, null, 2)}\n`);
		return this.get();
	}
}

function normalizeState(value: PersistedStudioState): StudioState {
	return {
		broadcastDirectory: typeof value.broadcastDirectory === 'string' ? value.broadcastDirectory : '',
		broadcastRecursive: Boolean(value.broadcastRecursive),
		ordered: Boolean(value.ordered),
		prepDirectory: typeof value.prepDirectory === 'string' ? value.prepDirectory : '',
		updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null
	};
}
