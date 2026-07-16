import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AiDjAction, ListenerRequestFeedback } from '../src/lib/types.js';

const DEFAULT_MAX_RECEIPTS = 200;
const DEFAULT_TTL_MS = 5 * 60_000;
const UNAVAILABLE_MESSAGE = "That song isn't in our library. Try another request.";

type FeedbackReceipt = {
	tokenHash: Buffer;
	createdAt: number;
};

type ListenerFeedbackStoreOptions = {
	maxReceipts?: number;
	ttlMs?: number;
	now?: () => number;
	createToken?: () => string;
};

export class ListenerFeedbackStore {
	private readonly receipts = new Map<string, FeedbackReceipt>();
	private readonly maxReceipts: number;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly createToken: () => string;

	constructor(options: ListenerFeedbackStoreOptions = {}) {
		this.maxReceipts = Math.max(1, options.maxReceipts ?? DEFAULT_MAX_RECEIPTS);
		this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
		this.now = options.now ?? Date.now;
		this.createToken = options.createToken ?? (() => randomBytes(24).toString('base64url'));
	}

	issue(requestId: string): string {
		this.prune();
		const token = this.createToken();
		this.receipts.delete(requestId);
		this.receipts.set(requestId, {
			tokenHash: hashToken(token),
			createdAt: this.now()
		});
		while (this.receipts.size > this.maxReceipts) {
			const oldestRequestId = this.receipts.keys().next().value;
			if (typeof oldestRequestId !== 'string') {
				break;
			}
			this.receipts.delete(oldestRequestId);
		}
		return token;
	}

	authorize(requestId: string, token: string): boolean {
		this.prune();
		const receipt = this.receipts.get(requestId);
		if (!receipt || !token) {
			return false;
		}

		const candidateHash = hashToken(token);
		return timingSafeEqual(receipt.tokenHash, candidateHash);
	}

	delete(requestId: string): void {
		this.receipts.delete(requestId);
	}

	clear(): void {
		this.receipts.clear();
	}

	private prune(): void {
		const expiresBefore = this.now() - this.ttlMs;
		for (const [requestId, receipt] of this.receipts) {
			if (receipt.createdAt <= expiresBefore) {
				this.receipts.delete(requestId);
			}
		}
	}
}

export function feedbackForAiDjAction(action: AiDjAction | null): ListenerRequestFeedback {
	if (action?.status === 'analyzing') {
		return { status: 'pending', message: '' };
	}
	if (action?.status === 'ignored_unavailable' && action.decision === 'song_unavailable') {
		return { status: 'unavailable', message: UNAVAILABLE_MESSAGE };
	}
	return { status: 'complete', message: '' };
}

function hashToken(token: string): Buffer {
	return createHash('sha256').update(token).digest();
}
