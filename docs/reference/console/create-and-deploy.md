# Create and deploy Agents in the console

Use the [platform console](../console.md) to create an Agent, prepare its
credentials, and request deployment. If this is your first Agent on an existing
Installation, start with [Deploy your first Agent](../../guides/first-agent.md)
for access requirements and how to choose a Namespace.

## Create an Agent

1. Sign in, select the intended Namespace, open **Agents**, and select
   **Create Agent**.
2. Enter a name that is unique within the Namespace. Choose an execution mode
   and review the starter Configuration JSON. Dedicated uses `codex/gpt-5.1`;
   embedded uses `openai/gpt-5.1`. These are example models. Confirm your
   Installation has access to the model you choose. The form requires a JSON
   object. Changing modes updates untouched JSON; use **Reset template** if you
   want to replace your edits.
3. If you need Slack or Microsoft Teams, use the channel cards and select
   **Dedicated**. Channel settings and their plugin entries are saved with the
   Configuration when you select **Create Agent**. You can provision Slack
   credentials in the console after creation; Teams credentials and deployment
   use the [operator workflow](../../guides/deploy/production-agents.md#configure-the-agent-runtime).
4. Choose how the Agent will authenticate to its model. Use one of the options
   below, or choose **None** to save a draft and select a method later. A draft
   without a compatible method cannot be deployed.
5. Select **Create Agent**. A successful save opens the Agent detail page on
   **Saved draft**. No revision or workload exists yet. You can create or edit
   [workspace files](../console.md#edit-workspace-files) after deployment, once
   the gateway is reachable; the creation form does not save file contents.

| Authentication option            | What you need                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI API key**               | The ID of an existing [OCC Secret](../drivers/kubernetes-secret.md#create-a-namespace-owned-secret) in this Namespace. You need `operate` on that exact Secret; Secret `read` is not required. Enter the Secret ID, not the key.          |
| **ChatGPT service account**      | An account in this Namespace that you can read, an already issued credential, the matching Provider, and dedicated execution. The console does not issue the credential for you. Listing Providers requires Installation `administer`.    |
| **Operator-managed credentials** | An Installation using SSH with embedded OpenClaw. The operator configures the runtime host; OCC does not validate the credentials or model access. See [SSH credentials](../drivers/ssh-compute.md#credentials-and-supported-boundaries). |

Selecting a credential source does not change the configured model or execution
mode, or confirm that the provider accepts it. For API-key deployments, the
Agent's own service principal also needs `operate` on that Secret; ask an
administrator to [grant it before deploying](../../guides/deploy/production-agents.md#configure-the-agent-runtime).
See [harness authentication](../agents.md#harness-authentication) for the full rules.

If the Configuration saves but Agent creation fails, the form shows its ID and
keeps its JSON and execution mode fixed. Correct the Agent name or selections and
retry to reuse that Configuration. The two saves are separate; a failed Agent
save does not remove the Configuration. If a response is lost, the save may have
succeeded. The form disables further creation until you leave or refresh it.
Check the **Agents** list and, if the form showed a Configuration ID, the
[exact Configuration](../configuration.md#create-read-update-and-delete) before
starting again. If you cannot determine the outcome, give the displayed request
ID, if available, to your operator.

## Initial runtime credentials

On Kubernetes, open **Credentials** on the Agent's saved draft before its first
deployment. You need `read` on that Agent to check status and `operate` on it to
save credentials. This form does not accept an OpenAI API key; use the
model authentication selection described above.

1. If Slack is enabled, enter its app token and bot token. The fields are masked
   and cleared after submission; the browser does not store them in the URL,
   local storage, or Configuration.
2. Select **Save credentials**. OCC generates the gateway and app-server
   transport tokens and a local gateway password. The password is supplied only
   if the Configuration explicitly selects the supported environment reference;
   it is never returned by the credential API.
3. Confirm that **Transport** and, if enabled, **Slack** show **Stored**.
   This means the credentials were saved. It does not mean Slack accepted them
   or the gateway is connected. The console does not show Teams credential
   status; ask your operator to provision and deploy a Teams-enabled Agent.

This action only creates missing credentials for an undeployed Agent. It will
not rotate or overwrite existing credentials, and it checks that the Agent's
runtime has not started. If a save fails or the response is lost, select
**Refresh status** before retrying. Complete credential groups already saved are
kept; submitting different values for an existing group conflicts. Ask an
operator to investigate malformed or unrecognized credentials. There is no
automatic retry or rollback.

Credential values are stored in Agent-owned Kubernetes Secrets; audit records
never contain the values. See the [runtime credential API](../api.md#post-namespacesnamespaceidagentsagentidruntimecredentials)
for storage and permission details. For SSH with **Operator-managed credentials**,
follow the [SSH setup](../drivers/ssh-compute.md#credentials-and-supported-boundaries)
instead; the console does not wait for Kubernetes credential status.

## Deploy a saved draft

1. Open the Agent's **Saved draft**. Confirm that a compatible model
   authentication method is selected. On Kubernetes, confirm the required
   credential groups show **Stored**. If Teams is enabled, use the
   [operator deployment workflow](../../guides/deploy/production-agents.md#configure-the-agent-runtime)
   instead; the console cannot confirm Teams readiness.
2. Select **Deploy saved draft**. The console rechecks the Agent, Configuration,
   and, where applicable, credential status. If it says the draft or credentials
   changed, refresh and review the current values before retrying. Another edit
   can still occur after these checks; they do not lock the draft.
3. When the deployment request is accepted, the console opens **Workspace
   files** for the new revision. Files become available only after the gateway
   starts. Retry loading them if needed. An accepted request is not evidence that
   the Agent is running, that its model works, or that its channels are connected.

If a deployment response is lost, inspect the Agent's revision history before
trying again; the console does not automatically repeat an uncertain request.
To follow the deployment worker, use the [deployment status API](../agents.md#deployment-status).
The console does not display live runtime health. Ask your operator to
[verify the workload](../../guides/deploy/production-agents.md#verify-production-workloads)
if files remain unavailable or you need proof that the Agent is running.
