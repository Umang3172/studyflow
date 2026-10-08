// Playwright runs in Node; declare the one global the config reads so the web app needs no @types/node.
declare const process: { env: Record<string, string | undefined> };
