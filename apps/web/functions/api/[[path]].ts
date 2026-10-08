// Forward every /api/* request unchanged to the API Worker. No logic here.
type Env = { API: { fetch(request: Request): Promise<Response> } };
export const onRequest = ({ request, env }: { request: Request; env: Env }) => env.API.fetch(request);
