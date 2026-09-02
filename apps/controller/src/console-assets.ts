import { readFile } from "node:fs/promises";

export interface ConsoleAsset {
  readonly body: Buffer;
  readonly contentType: string;
  readonly statusCode: 200 | 404;
}

const CONSOLE_ROOT = new URL("./console/", import.meta.url);
const CONSOLE_SHELL = new URL("index.html", CONSOLE_ROOT);
const CONSOLE_ASSETS = new Map(
  Object.entries({
    "/console/console.css": {
      path: new URL("console.css", CONSOLE_ROOT),
      contentType: "text/css; charset=utf-8",
    },
    "/console/channels.css": {
      path: new URL("channels.css", CONSOLE_ROOT),
      contentType: "text/css; charset=utf-8",
    },
    "/console/channels.mjs": {
      path: new URL("channels.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/agents.mjs": {
      path: new URL("agents.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/dom.mjs": {
      path: new URL("dom.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
    "/console/console.mjs": {
      path: new URL("console.mjs", CONSOLE_ROOT),
      contentType: "text/javascript; charset=utf-8",
    },
  }),
);
const CONSOLE_SHELL_ROUTES = new Set([
  "/console",
  "/console/",
  "/console/login",
  "/console/agents",
  "/console/providers",
  "/console/namespaces",
  "/console/settings",
]);

export const CONSOLE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

export async function readConsoleAsset(pathname: string): Promise<ConsoleAsset> {
  const asset = CONSOLE_ASSETS.get(pathname);
  if (asset !== undefined) {
    return {
      body: await readFile(asset.path),
      contentType: asset.contentType,
      statusCode: 200,
    };
  }
  return {
    body: await readFile(CONSOLE_SHELL),
    contentType: "text/html; charset=utf-8",
    statusCode:
      CONSOLE_SHELL_ROUTES.has(pathname) ||
      /^\/console\/agents\/(new|agt_[a-f0-9-]+)$/.test(pathname)
        ? 200
        : 404,
  };
}
