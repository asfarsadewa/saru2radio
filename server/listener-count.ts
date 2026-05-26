export class ActiveListenerCounter {
	private readonly activeTokens = new Set<symbol>();

	get count(): number {
		return this.activeTokens.size;
	}

	register(): () => void {
		const token = Symbol('active-listener');
		this.activeTokens.add(token);
		let released = false;

		return () => {
			if (released) {
				return;
			}

			released = true;
			this.activeTokens.delete(token);
		};
	}

	reset(): void {
		this.activeTokens.clear();
	}
}
