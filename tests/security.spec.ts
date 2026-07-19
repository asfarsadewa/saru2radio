import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter, isAllowedStudioHost, isAllowedStudioOrigin } from '../server/security.js';

describe('studio origin guard', () => {
	it('allows the local studio origins and non-browser local tools', () => {
		expect(isAllowedStudioOrigin('http://127.0.0.1:8011', 8011)).toBe(true);
		expect(isAllowedStudioOrigin('http://localhost:8011', 8011)).toBe(true);
		expect(isAllowedStudioOrigin(undefined, 8011)).toBe(true);
	});

	it('rejects cross-origin and wrong-port browser requests', () => {
		expect(isAllowedStudioOrigin('https://example.com', 8011)).toBe(false);
		expect(isAllowedStudioOrigin('http://127.0.0.1:8012', 8011)).toBe(false);
		expect(isAllowedStudioOrigin('null', 8011)).toBe(false);
	});
});

describe('studio host guard', () => {
	it('allows loopback hosts on the studio port and host-less local tools', () => {
		expect(isAllowedStudioHost('127.0.0.1:8011', 8011)).toBe(true);
		expect(isAllowedStudioHost('localhost:8011', 8011)).toBe(true);
		expect(isAllowedStudioHost('[::1]:8011', 8011)).toBe(true);
		expect(isAllowedStudioHost(undefined, 8011)).toBe(true);
	});

	it('rejects foreign hosts, lookalikes, and wrong ports', () => {
		// The DNS-rebinding case: a browser resolves an attacker domain to
		// 127.0.0.1 but keeps sending the attacker domain in Host.
		expect(isAllowedStudioHost('evil.example.com:8011', 8011)).toBe(false);
		expect(isAllowedStudioHost('127.0.0.1.evil.example.com:8011', 8011)).toBe(false);
		expect(isAllowedStudioHost('127.0.0.1:8012', 8011)).toBe(false);
		expect(isAllowedStudioHost('not a host', 8011)).toBe(false);
	});
});

describe('FixedWindowRateLimiter', () => {
	it('blocks requests after the window limit until the window resets', () => {
		let now = 1_000;
		const limiter = new FixedWindowRateLimiter({
			limit: 2,
			windowMs: 1_000,
			now: () => now
		});

		expect(limiter.check('listener').allowed).toBe(true);
		expect(limiter.check('listener').allowed).toBe(true);
		expect(limiter.check('listener')).toEqual({ allowed: false, retryAfterSeconds: 1 });

		now += 1_001;

		expect(limiter.check('listener').allowed).toBe(true);
	});
});
