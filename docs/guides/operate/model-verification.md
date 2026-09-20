# Verify a production Agent's model response

Verify that a trusted-proxy Kubernetes gateway rejects an unauthenticated
request and returns a real model response. The private OCC workspace proxy
serves workspace administration; this check uses a separate gateway password
over a Kubernetes port-forward bound to your machine's loopback address. For
token-authenticated gateways, use the [OpenClaw TUI](../deploy/production-agents.md#attach-with-the-openclaw-tui).

## Prepare the Agent

You need an active Agent revision, a working model credential, `kubectl`
permission to port-forward a tenant Service's Pod, and the Agent's local gateway
password. If you retrieve the generated password from Kubernetes, you also need
read access to that exact Secret. Keep `AGENT_ID`, `TENANT_NAMESPACE`,
`KUBECONFIG_FILE`, and `CONTEXT` from the [production Agent guide](../deploy/production-agents.md).

Configure the Agent to serve model requests and use the Kubernetes-managed local
password. Add these fields to the existing native gateway Configuration without
removing the [trusted-proxy settings](../deploy/workspace-routing.md#configure-native-gateway-authentication)
or the Agent's model and Harness settings:

```yaml
gateway:
  auth:
    mode: trusted-proxy
    password:
      source: env
      provider: default
      id: OPENCLAW_GATEWAY_PASSWORD
  http:
    endpoints:
      chatCompletions:
        enabled: true
```

The [transport Secret](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials)
must have a `gateway-password` key. The initial credential API generates one;
external operators can provision one during [Agent deployment](../deploy/production-agents.md#configure-the-agent-runtime).
Deploy a new revision if these Configuration fields changed and wait for it to
become active. The password is separate from the model provider's credential.

## Open a local connection

In the first operator shell:

```bash
AGENT_SUFFIX="$(printf %s "$AGENT_ID" | shasum -a 256 | cut -c1-12)"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$TENANT_NAMESPACE" \
  port-forward --address 127.0.0.1 "service/gateway-$AGENT_SUFFIX" 18789:http
```

Leave the command running after `Forwarding from 127.0.0.1:18789` appears.
If that local port is occupied, change `18789` in both the forward and the
verification example. In another operator shell with the same environment, set `GATEWAY_PASSWORD_FILE`
to a protected file containing the password. If the credential API created it,
you can retrieve it without printing the value:

```bash
umask 077
GATEWAY_PASSWORD_DIRECTORY="$(mktemp -d)"
export GATEWAY_PASSWORD_FILE="$GATEWAY_PASSWORD_DIRECTORY/gateway-password"
AGENT_SUFFIX="$(printf %s "$AGENT_ID" | shasum -a 256 | cut -c1-12)"
TRANSPORT_SECRET="openclaw-agent-transport-$AGENT_SUFFIX"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$TENANT_NAMESPACE" \
  get secret "$TRANSPORT_SECRET" -o json | \
  python3 -c 'import base64,json,os,sys; from pathlib import Path; Path(os.environ["GATEWAY_PASSWORD_FILE"]).write_bytes(base64.b64decode(json.load(sys.stdin)["data"]["gateway-password"], validate=True))'
```

Replace `openclaw-agent-transport-` if your Installation sets a different
`runtime.transportSecretPrefix`. Export `GATEWAY_PASSWORD_FILE` if you use your
own protected file.

## Verify rejection and a real response

Run from the second shell while the forward is active:

```bash
python3 - <<'PY'
import json, os, secrets, urllib.error, urllib.request
from pathlib import Path

url = 'http://127.0.0.1:18789/v1/chat/completions'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
password = Path(os.environ['GATEWAY_PASSWORD_FILE']).read_text().strip()
if not password:
    raise SystemExit('The gateway password file is empty.')

def request(payload, password=None):
    headers = {'Content-Type': 'application/json'}
    if password:
        headers['Authorization'] = f'Bearer {password}'
    req = urllib.request.Request(url, json.dumps(payload).encode(), headers=headers)
    return opener.open(req, timeout=180)

try:
    with request({'model': 'openclaw/default', 'messages': []}):
        raise SystemExit('The gateway unexpectedly allowed an unauthenticated request.')
except urllib.error.HTTPError as error:
    if error.code not in (401, 403):
        raise SystemExit(f'Expected 401 or 403 without credentials; received {error.code}.')

nonce = 'OPENCLAW_' + secrets.token_hex(12)
payload = {'model': 'openclaw/default', 'stream': False, 'messages': [
    {'role': 'user', 'content': f'Reply with exactly this nonce and no other text: {nonce}'}]}
with request(payload, password) as response:
    message = json.load(response)['choices'][0]['message']['content']
if nonce not in message:
    raise SystemExit('The response did not contain the requested nonce.')
print(f'Model response verified ({nonce}).')
PY
```

Expect `Model response verified (OPENCLAW_...).` If the denial check fails, stop
and review gateway authentication before exposing the endpoint. If the model
call fails, check that the selected revision is active, its model credential is
valid, and the gateway and Harness are available. Use [platform troubleshooting](troubleshooting.md)
when the control plane or several Agents are affected.

Stop the port-forward with Ctrl+C. If you created a temporary password file
above, delete only that copy:

```bash
rm -- "$GATEWAY_PASSWORD_FILE"
rmdir -- "$GATEWAY_PASSWORD_DIRECTORY"
```
