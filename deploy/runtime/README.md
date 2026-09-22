# Runtime image recipe

Build a public local runtime image for the OpenClaw Enterprise quickstart and
real-runtime integration tests. The image contains both supported runtime
entrypoints:

- OpenClaw gateway: `node /app/openclaw.mjs`.
- Dedicated Codex app-server: `codex app-server`.

The Dockerfile builds OpenClaw and its Codex/Slack plugins from the same public
source snapshot. This makes the required workspace changes available before a
matching npm release. It verifies the archive checksum, installs dependencies
from the source lockfile with `--frozen-lockfile`, and uses OpenClaw's native
build, plugin packaging and native-addon checks. Build tools stay in build stages;
the final image receives production dependencies.

| Input                    | Default                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `NODE_BASE_IMAGE`        | `docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584` |
| `OPENCLAW_SOURCE_COMMIT` | `20db76a79212c7d0c4f2106fea4d61fdce9972a3` (package version `2026.9.5`)                                      |
| `OPENCLAW_SOURCE_SHA256` | `456e6d042aff7dec501c9417e86ee4c41ec480cde0418468d8436e5785f5a6d0`                                           |

The source lockfile also selects the Codex CLI version (`0.154.0` at this pin).
Update the source commit and archive checksum together; do not independently mix
OpenClaw, plugin and CLI versions. When changing the pin, align the creation-time
workspace defaults and supported setup version, then verify the resulting image.

Build it from the repository root:

```bash
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:quickstart \
  .
```

Set `OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart` for the
Compose quickstart. The Docker Compute Driver uses the same image for embedded
OpenClaw gateways and dedicated Codex app-server containers.

The image preserves the installed `openclaw` package under
`/app/node_modules/openclaw` and exposes `/app/openclaw.mjs` and `/app/dist` as
symlinks into that package. `/app/skills` is copied into a real directory so the
Kubernetes gateway entrypoint can publish it into the shared runtime-assets
volume for dedicated Codex Pods. Do not flatten `/app/dist`; OpenClaw resolves
package-local runtime dependencies from its installed package root.

Codex and Slack are packaged under `/app/dist/extensions/` with their runtime
dependencies. They must load from a fresh runtime home without downloading or
installing packages at gateway startup. Slack credentials remain operator-owned
runtime Secrets; do not put them in the image.

For a protected npm registry, pass its existing configuration as a BuildKit
secret with `--secret id=npmrc,src=/path/to/npmrc`. If Corepack needs the same
registry, supply `--secret id=COREPACK_NPM_REGISTRY,env=COREPACK_NPM_REGISTRY`.
Secrets are mounted only during dependency installation and are not copied into
image layers. Registry and source dependency-age checks remain enabled.

Production Kubernetes installations can use this recipe as a starting point,
but must push the resulting image to an operator-controlled registry and
configure the Kubernetes Compute Driver with immutable `@sha256:` image
references. Follow [Build and publish production images](../../docs/guides/deploy/production-installation.md#build-and-publish-production-images)
for the controller and runtime build commands, registry publishing, and digest
configuration.

## Select a storage-split test image

CI and local builds use this same Dockerfile and source pin. Both Gateway and
Harness images must contain the matching build and plugins; record their exact
image digests. The merged OC inventory and remaining Enterprise acceptance are
tracked in [#76](https://github.com/openclaw/openclaw-enterprise/issues/76).

An unmerged Enterprise PR can supply a candidate controller build for a disposable
staging environment. Record its exact commit and the selected runtime image
digests; PR merge status is not runtime verification. Use the existing
[Kubernetes test procedures](../../docs/testing/kubernetes.md) for explicit image
selection and proof. A successful image build does not establish model E2E acceptance.

## Rebuild an existing image

`scripts/dev-up` reuses the configured image tag and builds the default
`openclaw-enterprise-runtime:quickstart` image only when that tag is absent.
After changing this recipe or its source pin, run the build command above
explicitly, verify the rebuilt image, then run `./scripts/dev-up` again. For a
custom `OCC_DOCKER_RUNTIME_IMAGE`, build or pull that selected tag yourself.

For Kubernetes, publish the rebuilt image and update both Installation image
references to its verified immutable digest. Separate gateway and Codex images
require verification of that exact pair through the
[Kubernetes runtime tests](../../docs/testing/kubernetes.md#kubernetes-model-turns-and-secrets).

## Verify the local image

```bash
docker run --rm openclaw-enterprise-runtime:quickstart \
  node /app/openclaw.mjs --version

docker run --rm openclaw-enterprise-runtime:quickstart \
  codex --version
```

Then run the runtime startup smoke from the repository root with host Node.js
24+:

```bash
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart \
  node --test tests/integration/runtime-image-startup.test.mjs
```

The smoke starts task-owned containers with the Docker Compute Driver gateway
entrypoint and the Kubernetes Compute Driver gateway entrypoint, UID
`1000:1000`, a read-only root filesystem, and tmpfs-backed runtime directories.
Passing means an embedded OpenClaw gateway reaches `/readyz` from a fresh home,
the bundled Codex and Slack plugins load without missing package dependencies,
the installed Codex plugin successfully initializes the image's real Codex
app-server, and the Kubernetes dedicated-gateway startup path publishes the
bundled skills directory into `/home/node/openclaw-runtime-assets`. These checks
run without external network access or provider credentials. They do not make a
model call or establish a Slack connection.

Before enabling Slack in an Installation, run the
[live Slack test](../../docs/testing/slack.md#slack) with the verified image, projected
credentials, and the required proxy configuration. It must prove a real mention,
Codex turn, and gateway-authored reply; gateway readiness alone is insufficient.
