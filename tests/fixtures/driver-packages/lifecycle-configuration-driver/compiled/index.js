import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";

const modes = new Set(["normal", "fail-update", "crash-install", "spawn-hang-install"]);

export const configurationSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["effectsPath", "mode"],
  properties: {
    effectsPath: { type: "string" },
    childPidPath: { type: "string" },
    mode: { type: "string" },
  },
});

export function validateConfiguration(configuration) {
  if (typeof configuration.effectsPath !== "string" || configuration.effectsPath.length === 0) {
    throw new Error("The lifecycle fixture requires an effects path.");
  }
  if (!modes.has(configuration.mode)) {
    throw new Error("The lifecycle fixture mode is unsupported.");
  }
}

async function record(configuration, event) {
  await appendFile(configuration.effectsPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function hook(configuration, name, context) {
  await record(configuration, {
    hook: name,
    installationId: context.installationId,
    capability: context.capability,
    driverId: context.driverId,
    version: context.version,
    ...(context.previousVersion === undefined ? {} : { previousVersion: context.previousVersion }),
    aborted: context.signal.aborted,
  });
  if (configuration.mode === "fail-update" && name === "onUpdate") {
    throw new Error("fixture update failed after external effect");
  }
  if (configuration.mode === "crash-install" && name === "onInstall") {
    process.exit(86);
  }
  if (configuration.mode === "spawn-hang-install" && name === "onInstall") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    if (configuration.childPidPath !== undefined) {
      await appendFile(
        configuration.childPidPath,
        `${JSON.stringify({ pid: child.pid })}\n`,
        "utf8",
      );
    }
    await new Promise(() => {});
  }
}

export function createDriver({ id, implementation, configuration }) {
  validateConfiguration(configuration);
  const values = new Map();
  const key = ({ namespaceId, id: configurationId }) => `${namespaceId}/${configurationId}`;
  return Object.freeze({
    id,
    capability: "configuration",
    implementation,
    lifecycleHooks: Object.freeze({
      onInstall: (context) => hook(configuration, "onInstall", context),
      onUpdate: (context) => hook(configuration, "onUpdate", context),
      onUninstall: (context) => hook(configuration, "onUninstall", context),
    }),
    async create(value) {
      values.set(key(value), structuredClone(value));
      return structuredClone(value);
    },
    async read(reference) {
      const value = values.get(key(reference));
      if (value === undefined) throw new Error("The selected Configuration does not exist.");
      return structuredClone(value);
    },
    async update(value) {
      values.set(key(value), structuredClone(value));
      return structuredClone(value);
    },
    async delete(reference) {
      values.delete(key(reference));
    },
    async validate() {},
  });
}
