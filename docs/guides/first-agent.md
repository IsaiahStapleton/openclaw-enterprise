# Deploy your first Agent

Create an Agent in an existing OpenClaw Enterprise installation, request its
first deployment, and check what the console can tell you. This walkthrough
uses a Kubernetes installation, Dedicated execution, and an existing OpenAI API
key stored as a platform Secret. Leave Slack and Microsoft Teams disabled for
this first deployment.

## Before you start

Ask your platform operator for:

- The console URL and your provisioned email and password. The console has no
  public signup or password recovery.
- A Namespace you can read that is already `ready`.
- Permission to create Agents and Configurations in that Namespace, read the
  Agent and its Configuration and revisions, operate the Agent to save its
  runtime credentials, and deploy it. See [authorization](../reference/authorization.md).
- The ID of a same-Namespace Secret containing an OpenAI API key with access to
  the intended model. You need `operate` permission on the Secret to select it;
  the new Agent's own identity also needs `operate` on it before deployment.
  Share the Secret ID, never the key itself. See
  [model credential permissions](../reference/agents.md#harness-authentication).

If your team uses an issued ChatGPT service account instead, it requires
Dedicated execution and the matching Provider. Ask your operator to confirm the
account and grant access before following the
[console credential instructions](../reference/console/create-and-deploy.md#create-an-agent).
If you cannot select the matching Provider, ask your operator to handle that step.

## Steps

### 1. Sign in and choose your Namespace

Open the console URL, enter your email as **Username**, enter your password,
and select **Login**. Open **Namespaces** from the sidebar and confirm your
assigned Namespace shows `ready`. In the bottom **OpenClaw Enterprise** menu,
choose **Namespace**, select it, then open **Agents**.

If the Namespace is missing, stays in `provisioning`, or shows `failed`, ask
an operator to confirm access or provisioning before continuing. See
[Namespace status](../reference/namespaces.md#lifecycle).

### 2. Create the Agent

1. On **Agents**, select **Create Agent**.
2. Enter a name unique to this Namespace, for example `first-agent`.
3. Leave **Execution mode** set to **Dedicated** and **Provider (optional)** set
   to **None** for this OpenAI API key example.
4. Under **Harness authentication**, choose **OpenAI API key** and enter the
   Secret ID your operator supplied. Do not paste the key or put it in
   **Configuration JSON**.
5. Review **Configuration JSON**. The starter uses `codex/gpt-5.1`; it does not
   verify that your key can use that model. If your team uses another model, ask
   for the corresponding configuration before saving. Leave the channel cards
   disabled.
6. Select **Create Agent**. Successful creation opens the Agent's saved draft.
   Note the Agent ID for your operator if they still need to grant it Secret
   access.

The draft is saved, but nothing is running yet.

### 3. Save credentials and request deployment

1. Open **Credentials** on the saved draft.
2. If **Transport** is **Missing**, select **Save credentials**. Wait until it
   shows **Stored**. The platform generates these connection credentials; this
   step does not check your model key.
3. Select **Deploy saved draft** once the Agent can use the Secret. The console
   opens **Workspace files** when the deployment request is accepted. The files
   can remain unavailable while the gateway starts; opening this tab does not
   mean that deployment finished.

If a request loses its response, do not immediately repeat it. See
[troubleshooting](#troubleshooting) before submitting another request.

### 4. Check what actually deployed

On the Agent detail page, open **Configuration**, refresh, and look for
**Selected revision**. The first revision normally appears as **v1** if it
becomes active. A later deployment can change which revision is selected.

| What you see                                       | What it establishes                                                                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The deployment opens Workspace files               | The platform accepted the revision and queued deployment; it may still be waiting for a worker.                                                                   |
| The **Selected revision** is the expected revision | The control plane marked that revision active. It does not show live gateway health or prove that the model responds.                                             |
| An operator verifies a model response              | The installed Agent answered through its gateway and model using the operator's [runtime verification](deploy/production-agents.md#attach-with-the-openclaw-tui). |

The console always shows **Serving status unavailable** and has no browser chat.
If you need to know that the Agent can answer, give an operator the Namespace,
Agent ID, and expected revision and ask them to verify the runtime. After the
active gateway is reachable, you can open **Workspace files** again; see
[workspace file access](../reference/console.md#edit-workspace-files).

## Troubleshooting

- **You cannot sign in or see your Namespace:** ask the operator to confirm
  your provisioned account and access. The console cannot reset your password.
- **Creation was interrupted:** check the Agent list before starting again. An
  operator can also check the saved Configurations. If the form shows a saved
  Configuration ID and confirms Agent creation failed, correct the name or
  permissions and retry on that form to reuse it. See
  [creation recovery](../reference/console/create-and-deploy.md#create-an-agent).
- **Credentials or deployment had an unknown outcome:** use **Refresh status**
  for credentials; inspect the Agent and its revision history before repeating
  deployment. The earlier request may have succeeded. See
  [deployment recovery](../reference/console/create-and-deploy.md#deploy-a-saved-draft).
- **Deployment is blocked or no revision becomes selected:** confirm **Transport**
  is **Stored**, then ask your operator to check the Agent and Secret permissions
  and the [deployment status](../reference/agents.md#deployment-status). Include
  the Namespace, Agent ID, and any request ID shown; do not send credential values.
