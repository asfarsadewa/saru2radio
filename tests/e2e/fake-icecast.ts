import { createServer, type ServerResponse } from 'node:http';

const port = Number(process.env.TEST_ICECAST_PORT ?? 18_010);
let chunks: Buffer[] = [];
let chunkTimes: number[] = [];
let chunkSizes: number[] = [];
let sourceRequests = 0;
const sourceResponses = new Set<ServerResponse>();

const server = createServer((request, response) => {
	const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
	if (request.method === 'GET' && url.pathname === '/') {
		response.writeHead(200, { 'content-type': 'text/plain' });
		response.end('fake icecast ready');
		return;
	}
	if (request.method === 'POST' && url.pathname === '/__test__/reset') {
		chunks = [];
		chunkTimes = [];
		chunkSizes = [];
		sourceRequests = 0;
		response.writeHead(204);
		response.end();
		return;
	}
	if (request.method === 'GET' && url.pathname === '/__test__/stats') {
		response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		response.end(
			JSON.stringify({
				totalBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
				chunkTimes,
				chunkSizes,
				sourceRequests
			})
		);
		return;
	}
	if (request.method === 'GET' && url.pathname === '/__test__/capture.mp3') {
		response.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
		response.end(Buffer.concat(chunks));
		return;
	}
	if (request.method === 'PUT' && url.pathname === '/live.mp3') {
		sourceRequests += 1;
		sourceResponses.add(response);
		request.on('data', (chunk: Buffer) => {
			const copy = Buffer.from(chunk);
			chunks.push(copy);
			chunkTimes.push(Date.now());
			chunkSizes.push(copy.length);
		});
		const finish = () => {
			sourceResponses.delete(response);
			if (!response.writableEnded) {
				response.end();
			}
		};
		request.on('end', finish);
		request.on('close', finish);
		return;
	}

	response.writeHead(404, { 'content-type': 'text/plain' });
	response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
	console.log(`fake Icecast: http://127.0.0.1:${port}`);
});

const shutdown = () => {
	for (const response of sourceResponses) {
		response.end();
	}
	server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
