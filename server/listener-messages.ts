import { randomUUID } from 'node:crypto';
import type { ListenerMessage } from '../src/lib/types.js';

const MAX_MESSAGES = 100;
const MAX_NAME_CHARS = 40;
const MAX_MESSAGE_CHARS = 500;

export type ListenerMessageInput = {
	name?: unknown;
	message?: unknown;
};

export type ValidatedListenerMessageInput = {
	name: string;
	message: string;
};

export class ListenerMessageValidationError extends Error {}

export class ListenerMessageStore {
	private messages: ListenerMessage[] = [];

	constructor(private readonly maxMessages = MAX_MESSAGES) {}

	list(): ListenerMessage[] {
		return this.messages.map((message) => ({ ...message }));
	}

	create(input: ListenerMessageInput): ListenerMessage {
		const { name, message } = validateListenerMessageInput(input);
		const listenerMessage: ListenerMessage = {
			id: randomUUID(),
			name,
			message,
			receivedAt: new Date().toISOString()
		};

		this.messages = [listenerMessage, ...this.messages].slice(0, this.maxMessages);
		return { ...listenerMessage };
	}

	delete(id: string): ListenerMessage[] {
		this.messages = this.messages.filter((message) => message.id !== id);
		return this.list();
	}

	clear(): ListenerMessage[] {
		this.messages = [];
		return [];
	}
}

export function validateListenerMessageInput(input: ListenerMessageInput): ValidatedListenerMessageInput {
	return {
		name: normalizeRequiredString(input.name, 'Name', MAX_NAME_CHARS),
		message: normalizeRequiredString(input.message, 'Message', MAX_MESSAGE_CHARS)
	};
}

function normalizeRequiredString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== 'string') {
		throw new ListenerMessageValidationError(`${label} is required.`);
	}

	const trimmed = value.trim();
	if (!trimmed) {
		throw new ListenerMessageValidationError(`${label} is required.`);
	}
	if (trimmed.length > maxLength) {
		throw new ListenerMessageValidationError(`${label} must be ${maxLength} characters or fewer.`);
	}

	return trimmed;
}
