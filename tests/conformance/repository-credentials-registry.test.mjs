import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/providers/repository-credentials/github/registry.ts";
import { loadGitHubRepositoryRegistry } from "../../apps/controller/src/providers/repository-credentials/github/registry-loader.ts";

function registryInput() {
  return {
    version: 1,
    providerId: "github-primary",
    providerInstanceId: "github-com-primary",
    appId: "12345",
    githubInstallationId: "67890",
    maximumDurationSeconds: 86400,
    repositories: [
      {
        repositoryRef: "application",
        repositoryId: "34567",
        repository: "Example/Application",
        namespaces: [
          { namespaceId: "namespace-a", profiles: ["git-write", "git-read", "git-full"] },
          { namespaceId: "namespace-b", profiles: ["git-read"] },
        ],
      },
    ],
  };
}

test("canonical registry fingerprints bind exact authority and the selected Namespace policy", () => {
  const input = registryInput();
  const registry = validateGitHubRepositoryRegistry(input, "github-primary");
  const request = { namespaceId: "namespace-a", repositoryRef: "application" };
  const binding = resolveGitHubRepositoryBinding(registry, request);
  assert.equal(binding.profile, "git-write");
  assert.equal(binding.grant.repositoryId, "34567");
  assert.equal(registry.repositories[0].repository, "example/application");
  assert.match(binding.grant.grantId, /^sha256:[a-f0-9]{64}$/);

  // Input mutation, JSON property ordering, and policy list ordering cannot change a snapshot.
  input.repositories[0].namespaces[0].profiles.pop();
  assert.equal(
    resolveGitHubRepositoryBinding(registry, request).grant.grantId,
    binding.grant.grantId,
  );
  const reordered = registryInput();
  reordered.repositories[0].repository = "example/application";
  reordered.repositories[0].namespaces.reverse();
  reordered.repositories[0].namespaces
    .find((entry) => entry.namespaceId === "namespace-a")
    .profiles.reverse();
  assert.deepEqual(
    resolveGitHubRepositoryBinding(validateGitHubRepositoryRegistry(reordered), request),
    binding,
  );

  for (const mutate of [
    (value) => {
      value.providerId = "another-provider";
    },
    (value) => {
      value.providerInstanceId = "another-instance";
    },
    (value) => {
      value.appId = "12346";
    },
    (value) => {
      value.githubInstallationId = "67891";
    },
    (value) => {
      value.maximumDurationSeconds = 3600;
    },
    (value) => {
      value.repositories[0].repositoryId = "34568";
    },
    (value) => {
      value.repositories[0].repository = "example/renamed";
    },
    (value) => {
      value.repositories[0].namespaces[0].profiles = ["git-write"];
    },
  ]) {
    const changed = registryInput();
    mutate(changed);
    assert.notEqual(
      resolveGitHubRepositoryBinding(validateGitHubRepositoryRegistry(changed), request).grant
        .grantId,
      binding.grant.grantId,
    );
  }
  assert.notEqual(
    resolveGitHubRepositoryBinding(registry, { ...request, profile: "git-read" }).grant.grantId,
    binding.grant.grantId,
  );
  assert.notEqual(
    resolveGitHubRepositoryBinding(registry, { ...request, profile: "git-read" }).grant.grantId,
    resolveGitHubRepositoryBinding(registry, {
      ...request,
      namespaceId: "namespace-b",
      profile: "git-read",
    }).grant.grantId,
  );
  assert.throws(() => {
    registry.repositories[0].namespaces[0].profiles.push("git-read");
  }, TypeError);
});

test("registry refuses ambiguous repositories, wildcard policy, unsupported profiles and noncanonical IDs", () => {
  for (const mutate of [
    (value) => {
      value.appId = "01";
    },
    (value) => {
      value.githubInstallationId = "9007199254740992";
    },
    (value) => {
      value.repositories[0].repositoryId = "0";
    },
    (value) => {
      value.repositories[0].repository = "example/release..archive";
    },
    (value) => {
      value.repositories[0].namespaces[0].namespaceId = "*";
    },
    (value) => {
      value.repositories[0].namespaces[0].profiles = ["app-full"];
    },
    (value) => {
      value.repositories[0].namespaces[0].profiles = ["git-read", "git-read"];
    },
    (value) => {
      value.repositories[0].namespaces.push(value.repositories[0].namespaces[0]);
    },
    (value) => {
      value.repositories.push({ ...value.repositories[0], repositoryRef: "alias" });
    },
    (value) => {
      value.repositories.push({
        ...value.repositories[0],
        repositoryId: "44",
        repository: "example/other",
      });
    },
    (value) => {
      value.repositories[0].namespaces[0].token = "unexpected";
    },
    (value) => {
      value.maximumDurationSeconds = Infinity;
    },
  ]) {
    const input = registryInput();
    mutate(input);
    assert.throws(() => validateGitHubRepositoryRegistry(input), /invalid-repository-registry/);
  }
  assert.throws(
    () => validateGitHubRepositoryRegistry(registryInput(), "another-provider"),
    /invalid-repository-registry/,
  );
  const registry = validateGitHubRepositoryRegistry(registryInput());
  for (const request of [
    { namespaceId: "namespace-b", repositoryRef: "application" },
    { namespaceId: "namespace-a", repositoryRef: "missing" },
    { namespaceId: "namespace-c", repositoryRef: "application", profile: "git-read" },
    { namespaceId: "namespace-a", repositoryRef: "application", profile: "app-full" },
    { namespaceId: "namespace-a", repositoryRef: "application", profile: null },
  ]) {
    assert.throws(() => resolveGitHubRepositoryBinding(registry, request));
  }
});

test("registry loader accepts a bounded projected regular file and rejects unsafe file contents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "repository-registry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "registry.json");
  const projected = join(directory, "projected.json");
  await writeFile(file, JSON.stringify(registryInput()), { mode: 0o644 });
  await symlink(file, projected);
  assert.equal(
    (await loadGitHubRepositoryRegistry(projected, "github-primary")).providerId,
    "github-primary",
  );
  await assert.rejects(
    loadGitHubRepositoryRegistry(projected, "wrong-provider"),
    /invalid-repository-registry/,
  );
  await chmod(file, 0o666);
  await assert.rejects(
    loadGitHubRepositoryRegistry(projected, "github-primary"),
    /invalid-repository-registry/,
  );
  await chmod(file, 0o644);
  const validJson = JSON.stringify(registryInput());
  await writeFile(file, validJson.padEnd(256 * 1024 + 1, " "));
  await assert.rejects(
    loadGitHubRepositoryRegistry(projected, "github-primary"),
    /invalid-repository-registry/,
  );
  await assert.rejects(
    loadGitHubRepositoryRegistry(directory, "github-primary"),
    /invalid-repository-registry/,
  );
});
