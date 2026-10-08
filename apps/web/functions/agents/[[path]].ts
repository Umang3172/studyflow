// Forward every /agents/* request (HTTP and WebSocket upgrades) unchanged to the API Worker. No logic here.
type Env = { API: { fetch(request: Request): Promise<Response> } };
export const onRequest = ({ request, env }: { request: Request; env: Env }) => env.API.fetch(request);
