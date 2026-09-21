# API cheat sheet

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

## Operations

### Authentication accounts

- [`createAuthAccount`](../api.md#post-apiauthaccounts)

### Authentication sessions

- [`getAuthSession`](../api.md#get-apiauthsession)
- [`signInEmail`](../api.md#post-apiauthsigninemail)
- [`signOut`](../api.md#post-apiauthsignout)

### Service API keys

- [`createServiceKey`](../api.md#post-apiauthservicekeys)
- [`revokeServiceKey`](../api.md#delete-apiauthservicekeyskeyid)

### Installation

- [`getInstallation`](../api.md#get-installation)
- [`bootstrapInstallation`](../api.md#post-installationbootstrap)

### Namespaces

- [`listNamespaces`](../api.md#get-namespaces)
- [`getNamespace`](../api.md#get-namespacesnamespaceid)
- [`createNamespace`](../api.md#post-namespaces)
- [`deleteNamespace`](../api.md#delete-namespacesnamespaceid)

### Agents

- [`listAgents`](../api.md#get-namespacesnamespaceidagents)
- [`getAgent`](../api.md#get-namespacesnamespaceidagentsagentid)
- [`createAgent`](../api.md#post-namespacesnamespaceidagents)
- [`updateAgent`](../api.md#patch-namespacesnamespaceidagentsagentid)
- [`deployAgent`](../api.md#post-namespacesnamespaceidagentsagentiddeploy)
- [`stopAgent`](../api.md#post-namespacesnamespaceidagentsagentidstop)
- [`getAgentNativeAdmin`](../api.md#get-namespacesnamespaceidagentsagentidnativeadmin)
- [`deleteAgent`](../api.md#delete-namespacesnamespaceidagentsagentid)

### Agent deployments

- [`getAgentDeployment`](../api.md#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentid)

### Agent revisions

- [`listAgentRevisions`](../api.md#get-namespacesnamespaceidagentsagentidrevisions)
- [`getAgentRevision`](../api.md#get-namespacesnamespaceidagentsagentidrevisionsrevisionid)

### Agent runtime credentials

- [`getAgentRuntimeCredentials`](../api.md#get-namespacesnamespaceidagentsagentidruntimecredentials)
- [`provisionAgentRuntimeCredentials`](../api.md#post-namespacesnamespaceidagentsagentidruntimecredentials)

### Agent workspace files

- [`getAgentWorkspaceFile`](../api.md#get-namespacesnamespaceidagentsagentidworkspacefilesname)
- [`putAgentWorkspaceFile`](../api.md#put-namespacesnamespaceidagentsagentidworkspacefilesname)

### Configurations

- [`getConfiguration`](../api.md#get-namespacesnamespaceidconfigurationsconfigurationid)
- [`createConfiguration`](../api.md#post-namespacesnamespaceidconfigurations)
- [`updateConfiguration`](../api.md#patch-namespacesnamespaceidconfigurationsconfigurationid)
- [`deleteConfiguration`](../api.md#delete-namespacesnamespaceidconfigurationsconfigurationid)

### IAM access bindings

- [`listIAMAccessBindings`](../api.md#get-namespacesnamespaceidiamaccessbindings)
- [`getIAMAccessBinding`](../api.md#get-namespacesnamespaceidiamaccessbindingsbindingid)
- [`createIAMAccessBinding`](../api.md#post-namespacesnamespaceidiamaccessbindings)
- [`deleteIAMAccessBinding`](../api.md#delete-namespacesnamespaceidiamaccessbindingsbindingid)

### IAM roles

- [`listIAMRoles`](../api.md#get-namespacesnamespaceidiamroles)
- [`getIAMRole`](../api.md#get-namespacesnamespaceidiamrolesroleid)
- [`createIAMRole`](../api.md#post-namespacesnamespaceidiamroles)
- [`deleteIAMRole`](../api.md#delete-namespacesnamespaceidiamrolesroleid)

### Secrets

- [`getSecret`](../api.md#get-namespacesnamespaceidsecretssecretid)
- [`createSecret`](../api.md#post-namespacesnamespaceidsecrets)
- [`updateSecret`](../api.md#patch-namespacesnamespaceidsecretssecretid)
- [`deleteSecret`](../api.md#delete-namespacesnamespaceidsecretssecretid)

### Service accounts

- [`listServiceAccounts`](../api.md#get-namespacesnamespaceidserviceaccounts)
- [`getServiceAccount`](../api.md#get-namespacesnamespaceidserviceaccountsserviceaccountid)
- [`createServiceAccount`](../api.md#post-namespacesnamespaceidserviceaccounts)
- [`deleteServiceAccount`](../api.md#delete-namespacesnamespaceidserviceaccountsserviceaccountid)

### Service account credentials

- [`createServiceAccountCredential`](../api.md#post-namespacesnamespaceidserviceaccountsserviceaccountidcredentials)
- [`updateServiceAccountCredential`](../api.md#patch-namespacesnamespaceidserviceaccountsserviceaccountidcredential)

### Providers

- [`listProviders`](../api.md#get-providers)
