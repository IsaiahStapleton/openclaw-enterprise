# Documentation improvements

The site keeps its six sections: Getting Started, Topics, Integrations, Operate,
Reference, and Contribute. This report records seven gaps that could prevent a
reader from finishing a task or confirming it worked. The findings were
rechecked against
[main at bcff5e41](https://github.com/openclaw/openclaw-enterprise/commit/bcff5e41954fee68f2e4ee566f70762091126ed8)
on September 20, 2026. The documentation corrections are recorded below;
they have not been verified against a live installation.

## Priorities

**P1** means a reader could lose a recovery credential, verify the wrong
deployment, or get stuck before the first model response. **P2** means a
supported task lacked an accurate procedure, recovery instruction, or
networking explanation.

| #   | Priority | Status       | Improvement                                            |
| --- | -------- | ------------ | ------------------------------------------------------ |
| 1   | P1       | Docs updated | Make production credential cleanup safe                |
| 2   | P1       | Docs updated | Verify the requested Agent revision                    |
| 3   | P1       | Docs updated | Finish Kubernetes first-Agent IAM instructions         |
| 4   | P2       | Docs updated | Separate local and existing-installation instructions  |
| 5   | P2       | Docs updated | Document the contributor development loop              |
| 6   | P2       | Docs updated | Explain when workspace-file writes are unsafe to retry |
| 7   | P2       | Docs updated | Correct ChatGPT provider egress guidance               |

## Findings and corrections

### 1. Make production credential cleanup safe

Production setup pointed `OCC_SERVICE_KEY_FILE` at the retained bootstrap
credential. The Agent guide then removed whatever path the variable contained.
An initialized installation does not reissue lost bootstrap credentials.

The production setup now creates a working copy in a dedicated temporary
directory. The cleanup checks for that specific working copy and leaves a
caller-supplied key file alone. The credential lifecycle guide remains the
source for administrator recovery.

See [production API authentication](../guides/deploy/production-installation.md#authenticate-to-the-production-api),
[operator cleanup](../guides/deploy/production-agents.md#end-the-operator-session),
and [administrator recovery](../guides/deploy/credential-lifecycle.md#preserve-administrator-recovery).

### 2. Verify the requested Agent revision

The trusted-proxy guide connected to a Kubernetes Service shared by the Agent's
revisions. During an update, the previous gateway could still answer, so a
successful model response did not prove that the requested revision served it.

The guide now selects a Ready Pod mounting the requested revision's immutable
ConfigMap, requires a unique match, and forwards directly to that Pod. The
operator must stop if they cannot select that revision.

See [model verification](../guides/operate/model-verification.md#open-a-local-connection),
[worker activation order](../flows/controller-worker.md#6-persist-the-result-and-finish-revision-activation),
and [the production TUI procedure](../guides/deploy/production-agents.md#attach-with-the-openclaw-tui).

### 3. Finish Kubernetes first-Agent IAM instructions

The production Agent guide still described a private administrator handoff after
[PR #260](https://github.com/openclaw/openclaw-enterprise/pull/260) made the
Agent's service principal and Namespace IAM operations available through the
public API. Kubernetes Setup did not identify the required access.

The guides now identify the Installation `administer` and Namespace `read`
requirements, capture the Agent's `servicePrincipalId`, and use public roles
and access bindings to grant and verify `operate` on the exact runtime Secret
before deployment.

See [Kubernetes Setup](../guides/kubernetes-setup.md#3-authenticate-and-continue-to-an-agent),
[the Agent runtime procedure](../guides/deploy/production-agents.md#configure-the-agent-runtime),
[Namespace IAM policy](../reference/authorization.md#manage-namespace-policy),
and [the IAM CLI procedure](../guides/cli.md#manage-namespace-iam).

### 4. Separate local and existing-installation instructions

The console guide sent readers deploying an Agent on an existing installation to
a localhost walkthrough. That walkthrough explicitly does not verify Agents
created through the console or CLI.

The console now distinguishes the local walkthrough from the existing
installation's prerequisites and points readers to verification for the Agent
they actually created.

See [console create and deploy](../reference/console/create-and-deploy.md),
[production verification](../guides/deploy/production-agents.md#verify-production-workloads),
and [the local walkthrough's restrictions](../guides/first-agent.md#troubleshoot).

### 5. Document the contributor development loop

Contribute explained how to start the platform and choose checks, but not how to
see a controller, worker, or console edit in the running installation. The
documented teardown deletes the installation and its saved state.

The contributor and local Kubernetes guides now describe how to rebuild the
affected service, inspect it and its logs, and preserve the existing
installation while iterating. They distinguish those commands from a full
teardown.

See [Local Development](../contributing/local-development.md#run-the-platform-when-your-change-needs-it),
[profile startup](../guides/deploy/local-kubernetes-development.md#start-the-profile),
and [profile teardown](../guides/deploy/local-kubernetes-development.md#stop-and-clean-up).

### 6. Explain when workspace-file writes are unsafe to retry

The generated workspace-file PUT reference described `503` only as “Service
Unavailable.” The controller can also return `UNKNOWN_OUTCOME` when it cannot
confirm a write or its audit record. A blind retry can repeat a successful
write.

The owning contract and generated reference now distinguish
`DEPENDENCY_UNAVAILABLE` from `UNKNOWN_OUTCOME` and tell callers to read the
file back before deciding whether to retry an uncertain write. The HTTP
quickstart limits its general retry advice to the GET requests it demonstrates.

See [workspace-file PUT](../reference/api.md#put-namespacesnamespaceidagentsagentidworkspacefilesname),
[Agent error and recovery guidance](../reference/agents.md#workspace-files),
[HTTP quickstart](../guides/http-api.md), and [the owning route contract](../../packages/contracts/src/api/routes.ts).

### 7. Correct ChatGPT provider egress guidance

The Helm example described `providerCidr` as a provider or proxy IP, but that
setting only changes the outbound network allowlist. The controller still calls
the fixed ChatGPT hostname; entering an ordinary forward proxy's IP does not
configure the application to use it.

The Provider and ChatGPT guides now explain the required network path and TLS
hostname, and identify successful credential issuance as the check for provider
connectivity. Listing Providers does not contact ChatGPT. The chart's guidance
also clarifies that the value does not configure a forward proxy.

See [Provider packaging](../reference/providers.md#production-packaging-and-verification),
[ChatGPT integration](../guides/integrations/chatgpt.md),
[ChatGPT client](../../apps/controller/src/providers/chatgpt.ts), and
[Helm NetworkPolicy](../../deploy/helm/openclaw-enterprise/templates/networkpolicies.yaml).

## Related cleanup and verification limits

[PR #259](https://github.com/openclaw/openclaw-enterprise/pull/259) removed
document Changelogs and empty Manual Notes from rendered articles, page
contents, and search while retaining their Markdown source. That editorial
cleanup is separate from the seven findings above.

The documentation was checked against controller code, API and CLI contracts,
and deployment configuration. No live Kubernetes deployment, model request,
credential issuance, or destructive credential cleanup was run for these
changes.
