# Build and validate repository credential configuration

Use the protected inputs and exact profiles in the [reference](../reference/repository-credentials.md).

## Build and validate

From the repository root with Node 24 and the pinned pnpm dependencies prepared,
build the controller output and emit the configuration-check artifact:

```sh
pnpm credentials:build
pnpm credentials:check-config /absolute/path/service.json
```

The check reads protected configuration, validates the RSA key and TLS inputs,
and prints JSON with `valid: true`, the gateway origin, allowed profiles, and
maximum session duration. It closes the loaded material owner without starting
listeners or calling GitHub. The emitted artifact uses Node built-ins and needs
no controller packages or runtime `node_modules`. The artifact is
`.build/repository-credentials/service/`, with entrypoint
`dist/composition/repository-credentials/check-config.js`.

This validates local inputs for the callable core. It does not establish GitHub
App installation permissions, credential issuance, deployed process isolation,
or Agent access. See the [testing guide](../testing/repository-credentials.md)
for the available controlled checks and their limits.

For `invalid-configuration`, inspect the file and every directory in its absolute
path. Use root or service-user ownership, private configuration/key files, and
directories that other users cannot modify. A root-owned sticky temporary
directory is allowed above the protected immediate parent. Move files out of
shared writable deployment directories before retrying; the complete policy is
in the [reference](../reference/repository-credentials.md#configuration).
