import { describe, expect, it } from 'vitest';
import { ListenerMessageStore, ListenerMessageValidationError } from '../server/listener-messages.js';

describe('ListenerMessageStore', () => {
	it('accepts and trims valid listener messages', () => {
		const store = new ListenerMessageStore();
		const message = store.create({ name: '  Adi  ', message: '  play KLa please  ' });

		expect(message).toMatchObject({
			name: 'Adi',
			message: 'play KLa please'
		});
		expect(message.id).toBeTruthy();
		expect(Date.parse(message.receivedAt)).not.toBeNaN();
		expect(store.list()).toEqual([message]);
	});

	it('rejects blank or too-long input', () => {
		const store = new ListenerMessageStore();

		expect(() => store.create({ name: ' ', message: 'hello' })).toThrow(ListenerMessageValidationError);
		expect(() => store.create({ name: 'Adi', message: '' })).toThrow(ListenerMessageValidationError);
		expect(() => store.create({ name: 'a'.repeat(41), message: 'hello' })).toThrow('Name must be 40 characters or fewer.');
		expect(() => store.create({ name: 'Adi', message: 'm'.repeat(501) })).toThrow('Message must be 500 characters or fewer.');
	});

	it('keeps the newest messages up to the configured cap', () => {
		const store = new ListenerMessageStore(3);

		store.create({ name: 'One', message: 'first' });
		store.create({ name: 'Two', message: 'second' });
		store.create({ name: 'Three', message: 'third' });
		store.create({ name: 'Four', message: 'fourth' });

		expect(store.list().map((message) => message.name)).toEqual(['Four', 'Three', 'Two']);
	});

	it('deletes one message and clears the inbox', () => {
		const store = new ListenerMessageStore();
		const first = store.create({ name: 'One', message: 'first' });
		const second = store.create({ name: 'Two', message: 'second' });

		expect(store.delete(first.id)).toEqual([second]);
		expect(store.clear()).toEqual([]);
		expect(store.list()).toEqual([]);
	});
});
