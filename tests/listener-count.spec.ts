import { describe, expect, it } from 'vitest';
import { ActiveListenerCounter } from '../server/listener-count.js';

describe('ActiveListenerCounter', () => {
	it('counts active listeners and releases each stream once', () => {
		const counter = new ActiveListenerCounter();
		const releaseFirst = counter.register();
		const releaseSecond = counter.register();

		expect(counter.count).toBe(2);

		releaseFirst();
		releaseFirst();
		expect(counter.count).toBe(1);

		releaseSecond();
		expect(counter.count).toBe(0);
	});

	it('resets listeners without letting stale releases decrement new streams', () => {
		const counter = new ActiveListenerCounter();
		const staleRelease = counter.register();

		counter.reset();
		expect(counter.count).toBe(0);

		const releaseCurrent = counter.register();
		staleRelease();
		expect(counter.count).toBe(1);

		releaseCurrent();
		expect(counter.count).toBe(0);
	});

	it('does not count failed or off-air streams that never register', () => {
		const counter = new ActiveListenerCounter();

		counter.reset();
		expect(counter.count).toBe(0);
	});
});
