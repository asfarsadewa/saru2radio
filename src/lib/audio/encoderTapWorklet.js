const PROCESSOR_NAME = 'saru2radio-encoder-tap';
const BATCH_SIZE = 2048;

class EncoderTapProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.capturePort = null;
		this.captureActive = false;
		this.closed = false;
		this.batch = new Float32Array(BATCH_SIZE);
		this.batchLength = 0;
		this.port.onmessage = (event) => {
			if (event.data?.type !== 'attach' || !event.data.port) {
				return;
			}
			this.capturePort = event.data.port;
			this.capturePort.onmessage = (message) => this.handleControl(message.data);
			this.capturePort.start();
		};
	}

	process(inputs, outputs) {
		for (const output of outputs) {
			for (const channel of output) {
				channel.fill(0);
			}
		}

		if (this.closed) {
			return false;
		}
		if (!this.captureActive || !this.capturePort) {
			return true;
		}

		const input = inputs[0]?.[0];
		if (!input) {
			return true;
		}

		let offset = 0;
		while (offset < input.length) {
			const writable = Math.min(this.batch.length - this.batchLength, input.length - offset);
			this.batch.set(input.subarray(offset, offset + writable), this.batchLength);
			this.batchLength += writable;
			offset += writable;
			if (this.batchLength === this.batch.length) {
				this.flushBatch();
			}
		}

		return true;
	}

	handleControl(message) {
		if (!this.capturePort || !message || typeof message !== 'object') {
			return;
		}

		if (message.type === 'capture') {
			this.captureActive = Boolean(message.active);
			if (!this.captureActive) {
				this.flushBatch();
			}
			this.capturePort.postMessage({
				type: 'capture-state',
				active: this.captureActive,
				requestId: message.requestId
			});
			return;
		}

		if (message.type === 'close') {
			this.captureActive = false;
			this.flushBatch();
			this.capturePort.postMessage({ type: 'closed', requestId: message.requestId });
			this.capturePort.close();
			this.capturePort = null;
			this.closed = true;
		}
	}

	flushBatch() {
		if (!this.capturePort || this.batchLength === 0) {
			return;
		}

		const samples = this.batchLength === this.batch.length ? this.batch : this.batch.slice(0, this.batchLength);
		this.batch = new Float32Array(BATCH_SIZE);
		this.batchLength = 0;
		this.capturePort.postMessage({ type: 'pcm', buffer: samples.buffer }, [samples.buffer]);
	}
}

registerProcessor(PROCESSOR_NAME, EncoderTapProcessor);
