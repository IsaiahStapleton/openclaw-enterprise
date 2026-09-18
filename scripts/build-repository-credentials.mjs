import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const emittedRoot = join(repositoryRoot, "apps/controller/dist");
const artifactRoot = join(repositoryRoot, ".build/repository-credentials");
const driverPath = "drivers/repository-credentials";

// Each process receives only its emitted owners, without controller package
// dependencies, workspace sources, declarations or incremental compiler state.
async function stage(name, owners) {
  const destination = join(artifactRoot, name);
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, "dist"), { recursive: true });
  for (const owner of owners) {
    await cp(join(emittedRoot, owner), join(destination, "dist", owner), {
      recursive: true,
      filter: async (source) => {
        if (name === "service" && source.startsWith(join(emittedRoot, driverPath, "client"))) {
          return false;
        }
        return (await stat(source)).isDirectory() || source.endsWith(".js");
      },
    });
  }
  await writeFile(
    join(destination, "package.json"),
    `${JSON.stringify({ name: `repository-credentials-${name}`, type: "module" }, null, 2)}\n`,
  );
  await cp(
    join(repositoryRoot, "deploy/runtime/repository-credentials/.dockerignore"),
    join(destination, ".dockerignore"),
  );
}

await stage("service", [
  "repository-credentials.js",
  "composition/repository-credentials",
  driverPath,
  "providers/repository-credentials",
]);
await stage("client", [`${driverPath}/client`]);
