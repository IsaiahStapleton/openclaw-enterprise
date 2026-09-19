import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readClientConfiguration } from "./config.ts";
import { readPrivateFile } from "./private-files.ts";

async function run(): Promise<void> {
  const [directory, operation] = process.argv.slice(2);
  if (!directory || !["get", "store", "erase"].includes(operation ?? "")) {
    throw new Error("invalid-helper-request");
  }
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 16 * 1024) {
      throw new Error("invalid-helper-request");
    }
  }
  // Store/erase are intentionally inert: the helper owns only a gateway session bearer.
  if (operation !== "get") {
    return;
  }
  if (
    [...input].some((character) => {
      const code = character.charCodeAt(0);
      return (code <= 0x1f && code !== 0x0a) || code === 0x7f;
    }) ||
    !input.endsWith("\n")
  ) {
    return;
  }
  const lines = input.split("\n");
  lines.pop();
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.some((line) => !line)) {
    return;
  }
  const fields = new Map<string, string>();
  for (const line of lines) {
    const offset = line.indexOf("=");
    if (offset < 1 || line.includes("\r") || line.includes("\0")) {
      return;
    }
    const key = line.slice(0, offset);
    if (fields.has(key) && key !== "capability[]" && key !== "wwwauth[]") {
      return;
    }
    if (
      ![
        "protocol",
        "host",
        "path",
        "username",
        "password",
        "password_expiry_utc",
        "oauth_refresh_token",
        "capability[]",
        "wwwauth[]",
      ].includes(key)
    ) {
      return;
    }
    fields.set(key, line.slice(offset + 1));
  }
  const configuration = await readClientConfiguration(directory);
  if (configuration.deadlineWallMs <= Date.now()) {
    throw new Error("repository-session-expired");
  }
  const remote = new URL(configuration.client.gitRemote);
  if (
    fields.get("protocol") !== "https" ||
    fields.get("host") !== remote.host ||
    fields.get("path") !== remote.pathname.slice(1) ||
    (fields.has("username") && fields.get("username") !== configuration.client.gitUsername)
  ) {
    return;
  }
  const bytes = await readPrivateFile(join(resolve(directory), "bearer"), 256);
  try {
    const bearer = bytes.toString("utf8");
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(bearer)) {
      throw new Error("invalid-client-bearer");
    }
    process.stdout.write(`username=${configuration.client.gitUsername}\npassword=${bearer}\n\n`);
  } finally {
    bytes.fill(0);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timer = setTimeout(() => {
    process.stderr.write("credential-helper-timeout\n");
    process.exit(1);
  }, 5000);
  run()
    .catch(() => {
      process.stderr.write("credential-helper-failed\n");
      process.exitCode = 1;
    })
    .finally(() => clearTimeout(timer));
}
