import type { Duplex } from 'node:stream';
import type { Request, RequestHandler } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type RateLimitResult = {
	allowed: boolean;
	retryAfterSeconds: number;
};

export type RateLimiterOptions = {
	limit: number;
	windowMs: number;
	now?: () => number;
};

type RateLimitBucket = {
	count: number;
	resetAt: number;
};

export class FixedWindowRateLimiter {
	private readonly now: () => number;
	private readonly buckets = new Map<string, RateLimitBucket>();

	constructor(private readonly options: RateLimiterOptions) {
		this.now = options.now ?? Date.now;
	}

	check(key: string): RateLimitResult {
		const now = this.now();
		this.prune(now);

		const existing = this.buckets.get(key);
		if (!existing || existing.resetAt <= now) {
			this.buckets.set(key, { count: 1, resetAt: now + this.options.windowMs });
			return { allowed: true, retryAfterSeconds: 0 };
		}

		if (existing.count >= this.options.limit) {
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
			};
		}

		existing.count += 1;
		return { allowed: true, retryAfterSeconds: 0 };
	}

	private prune(now: number): void {
		for (const [key, bucket] of this.buckets) {
			if (bucket.resetAt <= now) {
				this.buckets.delete(key);
			}
		}
	}
}

export function createStudioOriginGuard(studioPort: number): RequestHandler {
	return (request, response, next) => {
		if (SAFE_METHODS.has(request.method)) {
			next();
			return;
		}

		if (!isAllowedStudioOrigin(request.get('origin'), studioPort)) {
			response.status(403).type('text/plain').send('Forbidden origin.');
			return;
		}

		next();
	};
}

export function isAllowedStudioOrigin(origin: string | string[] | undefined, studioPort: number): boolean {
	const originValue = firstHeaderValue(origin);
	if (!originValue) {
		// Non-browser local tools often omit Origin. Browser cross-site writes include it.
		return true;
	}

	try {
		const normalized = new URL(originValue).origin;
		return studioAllowedOrigins(studioPort).has(normalized);
	} catch {
		return false;
	}
}

export function studioAllowedOrigins(studioPort: number): Set<string> {
	return new Set([`http://127.0.0.1:${studioPort}`, `http://localhost:${studioPort}`, `http://[::1]:${studioPort}`]);
}

const STUDIO_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function createStudioHostGuard(studioPort: number): RequestHandler {
	return (request, response, next) => {
		if (!isAllowedStudioHost(request.get('host'), studioPort)) {
			response.status(403).type('text/plain').send('Forbidden host.');
			return;
		}

		next();
	};
}

// DNS-rebinding defense: a browser that is tricked into resolving an attacker
// domain to 127.0.0.1 still sends that domain in the Host header, so rejecting
// non-loopback Host values closes the read side of the studio API to websites
// the DJ merely visits. The origin guard cannot cover this because it exempts
// safe methods (GET/HEAD/OPTIONS).
export function isAllowedStudioHost(host: string | string[] | undefined, studioPort: number): boolean {
	const hostValue = firstHeaderValue(host);
	if (!hostValue) {
		// Non-browser local tools may omit Host on HTTP/1.0. Browsers always send it.
		return true;
	}

	try {
		const url = new URL(`http://${hostValue.trim()}`);
		return STUDIO_HOSTNAMES.has(url.hostname.toLowerCase()) && (url.port || '80') === String(studioPort);
	} catch {
		return false;
	}
}

export function createRateLimitMiddleware(
	limiter: FixedWindowRateLimiter,
	keyForRequest: (request: Request) => string
): RequestHandler {
	return (request, response, next) => {
		const result = limiter.check(keyForRequest(request));
		if (!result.allowed) {
			response
				.status(429)
				.set('Retry-After', String(result.retryAfterSeconds))
				.type('text/plain')
				.send('Too many listener requests. Try again shortly.');
			return;
		}

		next();
	};
}

export function listenerRequestKey(request: Request): string {
	const cloudflareIp = firstHeaderValue(request.get('cf-connecting-ip'));
	const forwardedFor = firstHeaderValue(request.get('x-forwarded-for'));
	const forwardedIp = forwardedFor?.split(',')[0]?.trim();
	return cloudflareIp ?? (forwardedIp || request.ip || request.socket.remoteAddress || 'unknown');
}

export function rejectForbiddenUpgrade(socket: Duplex): void {
	socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
	socket.destroy();
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) {
		return value[0]?.trim() || undefined;
	}
	return value?.trim() || undefined;
}
