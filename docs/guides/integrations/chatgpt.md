# Use the ChatGPT Provider

The ChatGPT Provider lets an Installation issue ChatGPT service-account
credentials for dedicated Codex Agents. It manages accounts and credentials;
it does not choose the model or route inference. If you already have an OpenAI
API key, use [Agent model authentication](../../reference/agents.md#harness-authentication)
instead; you do not need a Provider.

## Before you start

An Installation operator needs Kubernetes Compute, PostgreSQL, the upstream
workspace ID, and an admin key authorized for that workspace with
`chatgpt.enterprise.service_account.write`. The key must be available to the OCC
API as a mounted file. Only one ChatGPT Provider is supported per Installation.

The person creating an account needs permission to create service accounts in
the Namespace and update the new account to issue its credential. The person
associating or deploying an Agent needs `read` on that exact account. See
[service-account permissions](../../reference/service-accounts.md#account-ownership-and-authorization).

## Configure and use the Provider

1. As the Installation operator, add the ChatGPT Provider and matching
   `service_account` Driver to the trusted Installation YAML. In production,
   configure the Helm Secret mount and approved API egress as well. Use the
   [Installation settings and Helm example](../../reference/providers.md#installation-configuration).
2. Confirm that the Provider appears in `GET /providers`. This requires
   `administer` on the Installation and checks OCC configuration only; it does
   not call ChatGPT or validate the admin key.
3. In the Agent's Namespace, create a service account with
   `POST /namespaces/:namespaceId/service-accounts`. Then issue its credential
   separately with
   `POST /namespaces/:namespaceId/service-accounts/:serviceAccountId/credentials`
   and the body `{}`. Each request should return `201`. See the
   [service-account lifecycle](../../reference/service-accounts.md#account-and-credential-lifecycle).
4. On a dedicated Codex Agent, select the configured `providerId` and that
   account for model authentication. For example, adapt this fragment for the
   Agent create or update request:

   ```json
   {
     "providerId": "openai",
     "harnessAuth": {
       "method": "chatgpt_service_account",
       "serviceAccountId": "<service-account-id>"
     }
   }
   ```

5. Deploy the saved Agent and [verify a model response](../operate/model-verification.md).
   A configured Provider or successful account creation does not prove that the
   Agent can use the issued credential. Only a real model response verifies
   that path.

## Troubleshoot

- **`403` from OCC:** check the exact Namespace, account, or Installation
  permission for the operation. Provider-side authorization is separate.
- **`404` from OCC:** check that the account exists in the Agent's exact
  Namespace.
- **`409 RESOURCE_CONFLICT` on deployment:** verify that the account has an
  issued credential from the selected Provider and Driver. Only dedicated Codex
  supports this binding.
- **`503 DEPENDENCY_UNAVAILABLE` when issuing:** confirm that the Installation
  selects the matching ServiceAccount Driver.
- **An existing credential stopped working:** expired credentials do not refresh
  automatically; issuing a second credential on the same account returns `409`.
  Create a replacement account, issue its credential, rebind and redeploy
  affected Agents, then delete the old account after nothing references it.
  See [service-account limits](../../reference/service-accounts.md#failures-and-current-limitations).

## Related

- [Providers reference](../../reference/providers.md)
- [Kubernetes Compute](../../reference/drivers/kubernetes-compute.md)
- [Agent model authentication](../../reference/agents.md#harness-authentication)
