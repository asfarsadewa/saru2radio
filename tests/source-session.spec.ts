import { describe, expect, it } from 'vitest';
import { BrowserSourceSessionGuard } from '../server/source-session.js';

describe('BrowserSourceSessionGuard', () => {
	it('lets the active browser source end the broadcast once', () => {
		const guard = new BrowserSourceSessionGuard();
		const session = guard.begin();

		expect(guard.endIfActive(session)).toBe(true);
		expect(guard.endIfActive(session)).toBe(false);
	});

	it('ignores stale source closes after a newer source has taken over', () => {
		const guard = new BrowserSourceSessionGuard();
		const staleSession = guard.begin();
		const currentSession = guard.begin();

		expect(guard.endIfActive(staleSession)).toBe(false);
		expect(guard.isActive(currentSession)).toBe(true);
		expect(guard.endIfActive(currentSession)).toBe(true);
	});

	it('ignores stale source closes after server-side song playout invalidates the browser source', () => {
		const guard = new BrowserSourceSessionGuard();
		const voiceSession = guard.begin();

		expect(guard.hasActive()).toBe(true);
		guard.invalidate();

		expect(guard.hasActive()).toBe(false);
		expect(guard.endIfActive(voiceSession)).toBe(false);
	});
});
