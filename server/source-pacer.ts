export type SourceStreamWriter = {
	write(chunk: Buffer): void;
};

export type SourceStreamPacerOptions = {
	tickMs?: number;
	prebufferSeconds?: number;
	maxWaitMs?: number;
	minBytesPerTick?: number;
};

const DEFAULT_TICK_MS = 100;
const DEFAULT_PREBUFFER_SECONDS = 1.4;
const DEFAULT_MAX_WAIT_MS = 1800;
const DEFAULT_MIN_BYTES_PER_TICK = 384;

export class SourceStreamPacer {
	private readonly bytesPerTick: number;
	private readonly prebufferBytes: number;
	private readonly maxWaitMs: number;
	private readonly startedAt = Date.now();
	private queue: Buffer[] = [];
	private offset = 0;
	private bufferedBytes = 0;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly source: SourceStreamWriter,
		bitrateKbps: number,
		options: SourceStreamPacerOptions = {}
	) {
		const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
		const minBytesPerTick = options.minBytesPerTick ?? DEFAULT_MIN_BYTES_PER_TICK;
		const bytesPerSecond = Math.max(1, (bitrateKbps * 1000) / 8);

		this.bytesPerTick = Math.max(minBytesPerTick, Math.round((bytesPerSecond * tickMs) / 1000));
		this.prebufferBytes = Math.round(bytesPerSecond * (options.prebufferSeconds ?? DEFAULT_PREBUFFER_SECONDS));
		this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
		this.timer = setInterval(() => this.drain(), tickMs);
	}

	push(chunk: Buffer): void {
		if (chunk.length === 0) {
			return;
		}

		this.queue.push(chunk);
		this.bufferedBytes += chunk.length;
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.queue = [];
		this.offset = 0;
		this.bufferedBytes = 0;
	}

	flush(): void {
		this.writeBytes(this.bufferedBytes);
	}

	private drain(): void {
		if (this.bufferedBytes === 0) {
			return;
		}

		const waitedLongEnough = Date.now() - this.startedAt >= this.maxWaitMs;
		if (this.bufferedBytes < this.prebufferBytes && !waitedLongEnough) {
			return;
		}

		const pressure = this.bufferedBytes / Math.max(1, this.prebufferBytes);
		const drainBytes = Math.round(this.bytesPerTick * (pressure > 2.5 ? 3 : pressure > 1.7 ? 2 : 1));
		this.writeBytes(drainBytes);
	}

	private writeBytes(maxBytes: number): void {
		let remaining = maxBytes;
		while (remaining > 0 && this.queue.length > 0) {
			const current = this.queue[0];
			const available = current.length - this.offset;
			const size = Math.min(available, remaining);
			this.source.write(current.subarray(this.offset, this.offset + size));
			this.offset += size;
			this.bufferedBytes -= size;
			remaining -= size;

			if (this.offset >= current.length) {
				this.queue.shift();
				this.offset = 0;
			}
		}
	}
}
