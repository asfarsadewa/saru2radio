// Shared RMS computation behind the booth's meters. The engine's output and
// mic meters and the studio's direct-monitor meter all used to duplicate this
// byte-time-domain -> RMS loop verbatim.
export function rmsTimeDomainLevel(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>): number {
	analyser.getByteTimeDomainData(data);
	let sum = 0;
	for (const value of data) {
		const normalized = (value - 128) / 128;
		sum += normalized * normalized;
	}
	return Math.sqrt(sum / data.length);
}
