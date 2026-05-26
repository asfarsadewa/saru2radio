export class BrowserSourceSessionGuard {
	private nextId = 0;
	private activeId = 0;

	begin(): number {
		const id = (this.nextId += 1);
		this.activeId = id;
		return id;
	}

	invalidate(): void {
		this.activeId = 0;
	}

	isActive(id: number): boolean {
		return id !== 0 && this.activeId === id;
	}

	endIfActive(id: number): boolean {
		if (!this.isActive(id)) {
			return false;
		}
		this.activeId = 0;
		return true;
	}
}
