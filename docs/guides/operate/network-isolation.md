# Check Agent network isolation

Confirm that your cluster enforces the
[documented network boundaries](../../reference/drivers/kubernetes-compute/networking-and-isolation.md)
for the control plane and tenant Agents. You run short TCP and DNS probes from
inside the real workload Pods and from test Pods that carry chosen labels, then
compare each result with the expected outcome below.

Run this check after you [deploy a production Agent](../deploy/production-agents.md),
after a CNI or NetworkPolicy change, and after an upgrade. Kubernetes combines
every matching policy, so a stale or extra allow policy can open a path that
OCC's own policies deny. Only a probe through the enforcing CNI shows the
combined result.

## Before you begin

You need:

- An enforcing NetworkPolicy implementation. Without one, every probe connects.
- `kubectl` permission to `exec` into Pods and to create and delete Pods and a
  Namespace.
- `KUBECONFIG_FILE`, `CONTEXT`, `TENANT_NAMESPACE`, `GATEWAY_RUNTIME_NAMESPACE`
  and `AGENT_ID` from the [production Agent guide](../deploy/production-agents.md).
- One running Agent. To check Agent-to-Agent isolation you need a second Agent
  in the same OCC Namespace; to check cross-Namespace isolation, an Agent in
  another OCC Namespace.

The probe runs with `node`, which the OCC controller image, the OpenClaw gateway
and the dedicated Codex Harness provide. Harness Pods provisioned by a
SandboxDriver such as OpenShell are outside this check: their provider fences
their egress.

## Set up the probe

Define a `kubectl` wrapper and a probe that prints one result per target.
A target is `host:port`, or `dns:name` for a lookup:

```bash
k() { kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" "$@"; }
PROBE_JS='
const net = require("net"), dns = require("dns");
const one = (t) => new Promise((done) => {
  const timer = setTimeout(() => done("TIMEOUT"), 3000);
  const end = (v) => { clearTimeout(timer); done(v); };
  if (t.startsWith("dns:")) {
    dns.lookup(t.slice(4), (e, a) => end(e ? e.code : "RESOLVED " + a));
    return;
  }
  const i = t.lastIndexOf(":");
  const s = net.connect({ host: t.slice(0, i), port: Number(t.slice(i + 1)) });
  s.on("connect", () => { s.destroy(); end("OPEN"); });
  s.on("error", (e) => end(e.code));
});
(async () => {
  for (const t of process.argv.slice(1)) console.log(t.padEnd(48), await one(t));
})();'
probe() { local ns=$1 pod=$2 container=$3; shift 3
  k -n "$ns" exec "$pod" -c "$container" -- node -e "$PROBE_JS" "$@"; }
```

`OPEN` means the connection was allowed. A denied connection reports
`ECONNREFUSED` on CNIs that reject (kube-router) or `TIMEOUT` on CNIs that drop
packets. `ECONNREFUSED` also means that nothing listens there, so each denial
needs a source that reaches the same target: a control Pod in a Namespace without
policies for dependencies and the internet, and the Agent's own gateway for its
Harness ports. A Pod probing its own address always connects; ignore that row.

## Collect the targets

Find the Agent's Pods and addresses. A dedicated Agent has a gateway Pod in the
Gateway runtime namespace and a Harness Pod in the tenant namespace:

```bash
pod() { k -n "$1" get pods -l "openclaw.dev/agent=$2,openclaw.dev/workload-role=$3" \
  -o jsonpath='{.items[0].metadata.name}'; }
HARNESS_POD=$(pod "$TENANT_NAMESPACE" "$AGENT_ID" agent) HARNESS_CONTAINER=agent
GATEWAY_POD=$(pod "$GATEWAY_RUNTIME_NAMESPACE" "$AGENT_ID" gateway)
HARNESS_IP=$(k -n "$TENANT_NAMESPACE" get pod "$HARNESS_POD" -o jsonpath='{.status.podIP}')
GATEWAY_IP=$(k -n "$GATEWAY_RUNTIME_NAMESPACE" get pod "$GATEWAY_POD" -o jsonpath='{.status.podIP}')
API_SERVICE="$(k -n default get service kubernetes -o jsonpath='{.spec.clusterIP}'):443"
API_ENDPOINT=$(k -n default get endpointslice kubernetes \
  -o jsonpath='{.endpoints[0].addresses[0]}:{.ports[0].port}')
export DATABASE='db.internal.example:5432'   # your PostgreSQL host:port
export PRIVATE_HTTPS='10.0.0.10:443'         # a private address that serves HTTPS, such as an internal load balancer
IMAGE=$(k -n openclaw-system get deployment openclaw-enterprise-api \
  -o jsonpath='{.spec.template.spec.containers[0].image}')
```

An embedded Agent runs in one gateway Pod in the tenant namespace. Set
`HARNESS_POD=$(pod "$TENANT_NAMESPACE" "$AGENT_ID" gateway)` and
`HARNESS_CONTAINER=gateway`, and skip the gateway row below.

Replace `openclaw-system` if you installed the release elsewhere. Set
`OTHER_HARNESS_IP` to a Pod address of another Agent, and repeat with an Agent
in another OCC Namespace.

## Create the test Pods

Create a control Namespace without policies, a control Pod, and two Pods that
copy the Agent's identity labels with an unknown and a missing
`openclaw.dev/network-profile`:

```bash
test_pod() { # namespace name labels-json
  k apply -f - <<EOF
{"apiVersion":"v1","kind":"Pod","metadata":{"name":"$2","namespace":"$1","labels":$3},
 "spec":{"automountServiceAccountToken":false,"restartPolicy":"Never",
  "securityContext":{"runAsNonRoot":true,"runAsUser":1000,"seccompProfile":{"type":"RuntimeDefault"}},
  "containers":[{"name":"probe","image":"$IMAGE","command":["node","-e","setInterval(()=>{},1e9)"],
   "resources":{"requests":{"cpu":"10m","memory":"32Mi"},"limits":{"cpu":"200m","memory":"128Mi"}},
   "securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,
    "capabilities":{"drop":["ALL"]}}}]}}
EOF
}
k create namespace oce-netcheck
k label namespace oce-netcheck pod-security.kubernetes.io/enforce=restricted
test_pod oce-netcheck control '{"app":"oce-netcheck"}'
LABELS=$(k -n "$TENANT_NAMESPACE" get pod "$HARNESS_POD" -o json | python3 -c '
import json, sys
labels = json.load(sys.stdin)["metadata"]["labels"]
keep = {k: v for k, v in labels.items() if k.startswith("openclaw.dev/")
        and k not in ("openclaw.dev/network-profile", "openclaw.dev/service-principal")}
print(json.dumps(keep))')
test_pod "$TENANT_NAMESPACE" netcheck-profile-missing "$LABELS"
test_pod "$TENANT_NAMESPACE" netcheck-profile-unknown \
  "$(echo "$LABELS" | python3 -c 'import json,sys; l=json.load(sys.stdin); l["openclaw.dev/network-profile"]="unknown-v1"; print(json.dumps(l))')"
k wait --for=condition=Ready pod/control -n oce-netcheck --timeout=120s
k wait --for=condition=Ready pod/netcheck-profile-missing pod/netcheck-profile-unknown \
  -n "$TENANT_NAMESPACE" --timeout=120s
```

The test Pods use the installed controller image. If the node cannot pull it,
add the release's `imagePullSecrets` to the Pod. Neither test Pod matches the
Agent's Services, which also select `openclaw.dev/network-profile=broad-egress-v1`.

## Run the checks

Run the control Pod first. DNS, the Kubernetes API, the database, both
`1.1.1.1` ports and `PRIVATE_HTTPS` must be `OPEN`; skip any target your
network blocks for every Pod. The Agent ports refuse the control Pod, because
their own ingress policies admit only their peers:

```bash
TARGETS="dns:kubernetes.default.svc.cluster.local $API_SERVICE $API_ENDPOINT $DATABASE \
  1.1.1.1:443 1.1.1.1:80 $PRIVATE_HTTPS $HARNESS_IP:18790 $HARNESS_IP:18791 $GATEWAY_IP:8080"
probe oce-netcheck control probe $TARGETS
```

Then run each row and compare:

| Source                     | Command                                                                               | Expected                                                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane              | `probe openclaw-system deploy/openclaw-enterprise-api api $TARGETS`                   | DNS, both Kubernetes API addresses and the database are `OPEN`. Other addresses are denied unless you configured provider or sign-in `egressCidrs`, which open only those ranges on TCP/443. Agent ports are denied. Repeat with `deploy/openclaw-enterprise-worker worker`. |
| Agent egress               | `probe $TENANT_NAMESPACE $HARNESS_POD $HARNESS_CONTAINER $TARGETS 169.254.169.254:80` | DNS resolves and `1.1.1.1:443` is `OPEN`. Port 80, `PRIVATE_HTTPS`, the Kubernetes API, the database, metadata and the gateway are denied. With private routing, this installation's Envoy on TCP/10443 is also `OPEN`.                                                      |
| Gateway                    | `probe $GATEWAY_RUNTIME_NAMESPACE $GATEWAY_POD gateway $TARGETS`                      | DNS and its own Harness, `$HARNESS_IP:18790` and `:18791`, are `OPEN`. Everything else is denied: no internet, Kubernetes API or database.                                                                                                                                   |
| Other Agent                | Repeat the Agent and gateway rows with `$OTHER_HARNESS_IP:18790`                      | Denied, in both directions, for Agents in the same OCC Namespace and across Namespaces.                                                                                                                                                                                      |
| Unknown or missing profile | `probe $TENANT_NAMESPACE netcheck-profile-unknown probe $TARGETS`                     | Everything is denied, DNS included (`EAI_AGAIN` or `TIMEOUT`). Repeat with `netcheck-profile-missing`.                                                                                                                                                                       |
| Plugin status              | See below                                                                             | Reachable only through the Kubernetes API server proxy.                                                                                                                                                                                                                      |

Without private routing, the `network.gatewayClients` you configured can also
reach the gateway port.

The private status port admits only the API server's proxy sources from
`network.pluginStatusProxySourceCidrs`. Through the proxy, the status endpoint
answers; the gateway port does not:

```bash
k get --raw "/api/v1/namespaces/$TENANT_NAMESPACE/pods/$HARNESS_POD:18791/proxy/openclaw/runtime/status"
k get --raw "/api/v1/namespaces/$GATEWAY_RUNTIME_NAMESPACE/pods/$GATEWAY_POD:8080/proxy/"
```

For an embedded Agent, use its gateway Pod and the tenant namespace in both
commands. The first command prints a JSON status report, or an HTTP error from the status
server while the Pod starts. The second fails with
`error trying to reach service` and `502 Bad Gateway`. The control Pod showed
that other Pods cannot connect to `$HARNESS_IP:18791` directly. Repeat for
Agents on different nodes: the proxy source address can differ per node.

### Public console addresses

Agents reach any public address on TCP/443, so a console published on a public
address is reachable from every Agent, like from any internet client. OCC still
requires authentication for every request. With a console on a private address,
Agent connections to it are denied. This model egress grant is temporary; see
[network security](../../reference/security.md).

## Clean up

Delete the test Pods and the control Namespace:

```bash
k -n "$TENANT_NAMESPACE" delete pod netcheck-profile-missing netcheck-profile-unknown
k delete namespace oce-netcheck
```

## If a check fails

- A target that should be denied is `OPEN`: list every NetworkPolicy that selects
  the source Pod (`k get networkpolicy -A`) and look for an extra allow policy.
  Kubernetes grants the union of all matching policies.
- Every probe connects: the CNI does not enforce NetworkPolicy.
- An Agent cannot reach its model: check its
  [network profile](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#explicit-network-profiles)
  and the model egress exclusions.
- The status proxy fails for every Pod: set `network.pluginStatusProxySourceCidrs`
  to the API server's source addresses on each node.
