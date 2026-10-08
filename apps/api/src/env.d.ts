// Secrets and dev-only vars are not in wrangler.jsonc, so declare them next to the generated types.
declare namespace Cloudflare {
  interface Env {
    SESSION_SECRET: string;
    MOCK_AI?: string;
  }
}
