declare const worker: {
	fetch(request: Request): Promise<Response> | Response;
};

export default worker;
export function toOriginUrl(url: URL): URL;
export function offlineResponse(url: URL): Response;
