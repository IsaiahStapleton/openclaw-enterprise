# Build and validate repository credential configuration

Use the protected inputs and exact profiles in the [reference](../reference/repository-credentials.md).

## Build and validate

From a checkout with the repository's Node 24 and pinned pnpm dependencies
prepared, build only this application:

```sh
pnpm credentials:build
pnpm credentials:check-config /absolute/path/service.json
```

The check reads protected configuration, validates the RSA key and TLS inputs,
and prints a safe configuration summary. It does not start listeners or call
GitHub. The emitted app uses Node built-ins and needs no controller packages or
runtime `node_modules`.
