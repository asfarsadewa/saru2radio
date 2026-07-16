import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibraryManager } from '../server/library.js';
import { PreparationBusyError, PreparationManager } from '../server/preparation.js';

describe('PreparationManager', () => {
	it('inspects, prepares, resumes, and expands recursively without mutating source files', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-preparation-'));
		const rootSource = path.join(directory, 'root.mp3');
		const nestedDirectory = path.join(directory, 'album');
		const nestedSource = path.join(nestedDirectory, 'nested.flac');
		const convertedInputs: string[] = [];
		const createLibrary = () =>
			new LibraryManager('fake-tool', async (_exePath, input, output) => {
				convertedInputs.push(input);
				await fs.writeFile(output, `radio-copy:${path.basename(input)}`);
			});
		const manager = new PreparationManager('fake-tool', createLibrary);

		try {
			await fs.mkdir(nestedDirectory);
			await fs.writeFile(rootSource, 'root-original');
			await fs.writeFile(nestedSource, 'nested-original');

			const inspected = await manager.inspect(directory, { recursive: false });
			expect(inspected).toMatchObject({
				phase: 'ready',
				total: 1,
				ready: 0,
				pending: 1,
				recursive: false
			});

			expect(manager.start(directory, { recursive: false }).phase).toBe('scanning');
			const firstRun = await manager.waitForCompletion();
			expect(firstRun).toMatchObject({
				phase: 'completed',
				total: 1,
				ready: 1,
				pending: 0,
				completed: 1,
				converted: 1,
				skipped: 0,
				failed: 0
			});
			expect(convertedInputs).toEqual([rootSource]);
			expect(await fs.readFile(rootSource, 'utf8')).toBe('root-original');
			expect(await fs.readFile(nestedSource, 'utf8')).toBe('nested-original');

			manager.start(directory, { recursive: true });
			const recursiveRun = await manager.waitForCompletion();
			expect(recursiveRun).toMatchObject({
				phase: 'completed',
				total: 2,
				ready: 2,
				pending: 0,
				completed: 2,
				converted: 1,
				skipped: 1,
				failed: 0
			});
			expect(convertedInputs).toEqual([rootSource, nestedSource]);

			const reinspected = await manager.inspect(directory, { recursive: true });
			expect(reinspected).toMatchObject({
				phase: 'ready',
				total: 2,
				ready: 2,
				pending: 0
			});
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('reports per-track failures while keeping successful radio copies ready', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-preparation-failure-'));
		const manager = new PreparationManager(
			'fake-tool',
			() =>
				new LibraryManager('fake-tool', async (_exePath, input, output) => {
					if (path.basename(input) === 'bad.mp3') {
						throw new Error('synthetic converter failure');
					}
					await fs.writeFile(output, 'prepared');
				})
		);

		try {
			await fs.writeFile(path.join(directory, 'bad.mp3'), 'bad-original');
			await fs.writeFile(path.join(directory, 'good.mp3'), 'good-original');

			manager.start(directory, { recursive: false });
			const state = await manager.waitForCompletion();

			expect(state).toMatchObject({
				phase: 'completed',
				total: 2,
				ready: 1,
				pending: 1,
				completed: 2,
				converted: 1,
				failed: 1
			});
			expect(state.failures).toHaveLength(1);
			expect(state.failures[0]).toMatchObject({
				fileName: 'bad.mp3',
				message: 'synthetic converter failure'
			});
			expect(await fs.readFile(path.join(directory, 'bad.mp3'), 'utf8')).toBe('bad-original');
			expect(await fs.readFile(path.join(directory, 'good.mp3'), 'utf8')).toBe('good-original');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects overlapping preparation jobs and missing local processor setup', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-preparation-busy-'));
		const manager = new PreparationManager(
			'fake-tool',
			() =>
				new LibraryManager('fake-tool', async (_exePath, _input, output) => {
					await fs.writeFile(output, 'prepared');
				})
		);

		try {
			await fs.writeFile(path.join(directory, 'root.mp3'), 'original');
			manager.start(directory);
			expect(() => manager.start(directory)).toThrow(PreparationBusyError);
			await manager.waitForCompletion();

			const unavailable = new PreparationManager(null);
			expect(() => unavailable.start(directory)).toThrow('npm run setup:radio-sound');
		} finally {
			await manager.waitForCompletion();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it('marks cache folders as broadcast-only and refuses to prepare them again', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'saru2radio-preparation-cache-guard-'));
		const tracksDirectory = path.join(directory, '.saru2radio-cache', 'tracks');
		const manager = new PreparationManager('fake-tool');

		try {
			await fs.mkdir(tracksDirectory, { recursive: true });
			await fs.writeFile(path.join(tracksDirectory, 'copy.radio.mp3'), 'prepared');

			const inspected = await manager.inspect(tracksDirectory);
			expect(inspected).toMatchObject({
				phase: 'ready',
				total: 0,
				pending: 0,
				error: expect.stringContaining('original music folder')
			});
			expect(() => manager.start(tracksDirectory)).toThrow('original music folder');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
