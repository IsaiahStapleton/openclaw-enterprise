import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  arrangeProductionTopology,
  hash,
  kubectl,
  requiresProductionCluster,
} from "./harness-topology-k3d-real.mjs";

const invalidSlackAppToken = "xapp-invalid-nosend-runtime-diagnostics";
const invalidSlackBotToken = "xoxb-invalid-nosend-runtime-diagnostics";
const defaultAllowedUserId = "U0000000000";
const defaultChannelId = "C0000000000";
const proxyImage =
  process.env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE ?? process.env.OCC_TEST_KUBERNETES_RUNTIME_IMAGE;

const requiresNoSendSlackInvalid = {
  skip:
    process.env.OCC_TEST_SLACK_NOSEND_INVALID === "1"
      ? requiresProductionCluster.skip
      : "Set OCC_TEST_SLACK_NOSEND_INVALID=1 plus production k3d prerequisites to prove invalid Slack auth without sending messages.",
};

const requiresNoSendSlackLive = {
  skip:
    process.env.OCC_TEST_SLACK_NOSEND_LIVE === "1"
      ? requiresProductionCluster.skip
      : "Set OCC_TEST_SLACK_NOSEND_LIVE=1 plus production k3d prerequisites, APP_TOKEN/SLACK_APP_TOKEN and BOT_TOKEN/SLACK_BOT_TOKEN to prove authenticated connected Slack diagnostics without sending messages.",
};

const slackProxySource = String.raw`
const dns = require("node:dns/promises");
const http = require("node:http");
const net = require("node:net");

const allowedSuffixes = ["slack.com", "slack-gw.com", "slack-edge.com"];
const blockedIpv4Ranges = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToNumber(address) {
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0) >>> 0;
}

function ipv4InRange(address, base, prefixLength) {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

function publicIpv4(address) {
  return net.isIP(address) === 4 && !blockedIpv4Ranges.some(([base, prefix]) => ipv4InRange(address, base, prefix));
}

function parseAuthority(authority) {
  if (typeof authority !== "string" || authority.length > 300 || /[\s/@]/u.test(authority)) return undefined;
  const separator = authority.lastIndexOf(":");
  if (separator <= 0 || separator === authority.length - 1) return undefined;
  const host = authority.slice(0, separator).toLowerCase().replace(/\.$/u, "");
  const port = Number(authority.slice(separator + 1));
  if (!Number.isInteger(port) || port !== 443) return undefined;
  if (!/^[a-z0-9.-]+$/u.test(host) || host.split(".").some((part) => part.length === 0 || part.length > 63)) return undefined;
  if (!allowedSuffixes.some((suffix) => host === suffix || host.endsWith("." + suffix))) return undefined;
  return { host, port };
}

function deny(socket, status = 403) {
  socket.end("HTTP/1.1 " + status + " Forbidden\r\nConnection: close\r\n\r\n");
}

async function resolveTarget(host) {
  const addresses = await dns.lookup(host, { all: true, family: 4, verbatim: false });
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error("empty DNS response");
  if (addresses.some((entry) => !publicIpv4(entry.address))) throw new Error("blocked DNS response");
  const selected = addresses.find((entry) => entry.family === 4);
  if (selected === undefined) throw new Error("missing public IPv4 response");
  return selected.address;
}

const server = http.createServer((_request, response) => {
  response.writeHead(405, { connection: "close" });
  response.end();
});

server.on("connect", async (request, clientSocket, head) => {
  const authority = parseAuthority(request.url);
  if (authority === undefined) {
    deny(clientSocket);
    return;
  }
  let upstream;
  try {
    const address = await resolveTarget(authority.host);
    upstream = net.connect({ host: address, port: 443, timeout: 10_000 });
    upstream.setTimeout(120_000);
    clientSocket.setTimeout(120_000);
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.once("timeout", () => upstream.destroy());
    clientSocket.once("timeout", () => clientSocket.destroy());
    upstream.once("error", () => clientSocket.destroy());
    clientSocket.once("error", () => upstream?.destroy());
    clientSocket.once("close", () => upstream?.destroy());
  } catch {
    upstream?.destroy();
    deny(clientSocket);
  }
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(Number(process.env.OCC_SLACK_PROXY_PORT ?? "3128"), "0.0.0.0");
`;

function assertNoSecretMaterial(value, secrets, description) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) {
    assert.equal(
      serialized.includes(secret),
      false,
      `${description} must not expose secret material`,
    );
  }
}

function noSendSlackFixture(overrides = {}) {
  return {
    proxyUrl: overrides.proxyUrl ?? process.env.OCC_TEST_SLACK_PROXY_URL ?? "http://127.0.0.1:9",
    allowedUserId: overrides.allowedUserId ?? defaultAllowedUserId,
    channelId: overrides.channelId ?? defaultChannelId,
    appToken: overrides.appToken ?? invalidSlackAppToken,
    botToken: overrides.botToken ?? invalidSlackBotToken,
    disableEventResponses: overrides.disableEventResponses ?? false,
  };
}

async function readyNoSendSlackProxyPodIp(namespace, name) {
  const pods = JSON.parse(
    await kubectl(
      "get",
      "pods",
      "--namespace",
      namespace,
      "--selector",
      `app.kubernetes.io/name=${name}`,
      "-o",
      "json",
    ),
  ).items.filter(
    (pod) =>
      pod.metadata?.deletionTimestamp === undefined &&
      pod.status?.phase === "Running" &&
      pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True") ===
        true,
  );
  assert.equal(
    pods.length,
    1,
    `Slack no-send proxy must resolve to exactly one Ready Pod, found ${pods.length}`,
  );
  const podIp = pods[0].status?.podIP;
  assert.match(
    podIp,
    /^\d+\.\d+\.\d+\.\d+$/u,
    "Slack no-send proxy Pod must have one observed IPv4 address",
  );
  return podIp;
}

async function ensureNoSendSlackProxy(context) {
  if (process.env.OCC_TEST_SLACK_PROXY_URL !== undefined) {
    return process.env.OCC_TEST_SLACK_PROXY_URL;
  }
  assert.ok(
    proxyImage,
    "OCC_TEST_KUBERNETES_GATEWAY_IMAGE or OCC_TEST_KUBERNETES_RUNTIME_IMAGE is required to create the bounded Slack CONNECT proxy when OCC_TEST_SLACK_PROXY_URL is unset.",
  );
  const namespace = `slack-nosend-${hash(randomUUID())}`;
  const name = "slack-connect-proxy";
  const directory = await mkdtemp(join(tmpdir(), "oce-slack-nosend-proxy-"));
  context.after(async () => {
    await kubectl("delete", "namespace", namespace, "--ignore-not-found=true").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const manifest = {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespace },
      },
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name, namespace },
        data: { "slack-proxy.cjs": slackProxySource },
      },
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name, namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: { "app.kubernetes.io/name": name } },
          template: {
            metadata: { labels: { "app.kubernetes.io/name": name } },
            spec: {
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                seccompProfile: { type: "RuntimeDefault" },
              },
              containers: [
                {
                  name: "proxy",
                  image: proxyImage,
                  imagePullPolicy: "IfNotPresent",
                  command: ["node", "/config/slack-proxy.cjs"],
                  ports: [{ name: "proxy", containerPort: 3128 }],
                  readinessProbe: { tcpSocket: { port: "proxy" }, periodSeconds: 2 },
                  resources: {
                    requests: { cpu: "25m", memory: "64Mi" },
                    limits: { cpu: "250m", memory: "256Mi" },
                  },
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ["ALL"] },
                  },
                  volumeMounts: [{ name: "proxy-code", mountPath: "/config", readOnly: true }],
                },
              ],
              volumes: [{ name: "proxy-code", configMap: { name } }],
            },
          },
        },
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name, namespace },
        spec: {
          podSelector: { matchLabels: { "app.kubernetes.io/name": name } },
          policyTypes: ["Ingress", "Egress"],
          ingress: [
            {
              from: [
                {
                  namespaceSelector: {},
                  podSelector: {
                    matchLabels: {
                      "app.kubernetes.io/managed-by": "openclaw-enterprise",
                      "openclaw.dev/workload-role": "gateway",
                    },
                  },
                },
              ],
              ports: [{ protocol: "TCP", port: 3128 }],
            },
          ],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                  },
                  podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
                },
              ],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
            {
              to: [{ ipBlock: { cidr: "0.0.0.0/0" } }],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
            {
              to: [
                {
                  ipBlock: {
                    cidr: "0.0.0.0/0",
                    except: [
                      "0.0.0.0/8",
                      "10.0.0.0/8",
                      "100.64.0.0/10",
                      "127.0.0.0/8",
                      "169.254.0.0/16",
                      "172.16.0.0/12",
                      "192.0.0.0/24",
                      "192.0.2.0/24",
                      "192.168.0.0/16",
                      "198.18.0.0/15",
                      "198.51.100.0/24",
                      "203.0.113.0/24",
                      "224.0.0.0/4",
                      "240.0.0.0/4",
                    ],
                  },
                },
              ],
              ports: [{ protocol: "TCP", port: 443 }],
            },
          ],
        },
      },
    ],
  };
  const manifestPath = join(directory, "slack-proxy.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  await kubectl("apply", "-f", manifestPath);
  await kubectl(
    "rollout",
    "status",
    `deployment/${name}`,
    "--namespace",
    namespace,
    "--timeout=180s",
  );
  // The gateway channel NetworkPolicy allows one exact proxy IP. Point the
  // gateway at the Ready Pod IP so k3d/k3s Service DNAT cannot make policy
  // enforcement see a different endpoint than the configured proxy address.
  const podIp = await readyNoSendSlackProxyPodIp(namespace, name);
  const proxyUrl = `http://${podIp}:3128`;
  context.diagnostic(`slack no-send proxy ready at ${proxyUrl}`);
  return proxyUrl;
}

async function runDiagnostics(topology, agent, revision, protectedValues = []) {
  const response = await topology.request(
    "POST",
    `/namespaces/${agent.namespaceId}/agents/${agent.id}/deployments/${revision.id}/diagnostics`,
  );
  assertNoSecretMaterial(response, protectedValues, "Slack no-send diagnostics response");
  assert.equal(response.status, 200, JSON.stringify(response.error));
  assert.equal(response.data.revisionId, revision.id);
  assert.equal(typeof response.data.observedAt, "string");
  assert.equal(Number.isNaN(Date.parse(response.data.observedAt)), false);
  assert.ok(Array.isArray(response.data.checks));
  return response.data;
}

function gatewayChannelChecks(diagnostics) {
  const byCheck = new Map(
    diagnostics.checks
      .filter((check) => check.component === "gateway")
      .map((check) => [check.check, check]),
  );
  for (const name of ["configuration", "authentication", "connectivity"]) {
    assert.ok(byCheck.has(name), `diagnostics must include gateway ${name} channel status`);
  }
  return byCheck;
}

function assertUnreachableSlackNotConnected(diagnostics) {
  const checks = gatewayChannelChecks(diagnostics);
  const observed = Object.fromEntries(
    ["configuration", "authentication", "connectivity"].map((name) => [
      name,
      { state: checks.get(name).state, code: checks.get(name).code },
    ]),
  );
  assert.notEqual(
    checks.get("connectivity").state,
    "succeeded",
    `unreachable Slack proxy must not report connected: ${JSON.stringify(observed)}`,
  );
  assert.ok(
    ["failed", "unknown"].includes(checks.get("connectivity").state),
    `unreachable Slack proxy must fail closed or report an unavailable probe: ${JSON.stringify(
      observed,
    )}`,
  );
}

function assertInvalidAuthRejected(diagnostics) {
  const checks = gatewayChannelChecks(diagnostics);
  assert.deepEqual(
    { state: checks.get("authentication").state, code: checks.get("authentication").code },
    { state: "failed", code: "AUTHENTICATION_FAILED" },
    `invalid Slack credentials must map to structured AUTHENTICATION_FAILED diagnostics: ${JSON.stringify(
      Object.fromEntries(checks),
    )}`,
  );
}

function assertConnectedSlackChecks(diagnostics) {
  const checks = gatewayChannelChecks(diagnostics);
  assert.deepEqual(
    Object.fromEntries(
      ["configuration", "authentication", "connectivity"].map((name) => [
        name,
        { state: checks.get(name).state, code: checks.get(name).code },
      ]),
    ),
    {
      configuration: { state: "succeeded", code: undefined },
      authentication: { state: "succeeded", code: undefined },
      connectivity: { state: "succeeded", code: undefined },
    },
  );
}

function slackNoSendShapeSummary(revision) {
  const slack = revision.configuration?.channels?.slack;
  const allowFromLength = Array.isArray(slack?.allowFrom) ? slack.allowFrom.length : "missing";
  const channelKeys =
    slack?.channels !== undefined && typeof slack.channels === "object" && slack.channels !== null
      ? Object.keys(slack.channels).length
      : "missing";
  return `enabled=${String(slack?.enabled)} mode=${String(slack?.mode)} dmPolicy=${String(slack?.dmPolicy)} allowFrom=${allowFromLength} channelKeys=${channelKeys}`;
}

function assertNoSendSlackPrerequisites(revision) {
  const slack = revision.configuration?.channels?.slack;
  assert.equal(slack?.enabled, true, "Slack no-send proof requires Slack to be enabled");
  assert.equal(slack?.mode, "socket", "Slack no-send proof requires Socket Mode");
  assert.equal(slack?.dmPolicy, "allowlist");
  assert.deepEqual(slack?.allowFrom, [], "Slack no-send proof must disable DM replies");
  assert.deepEqual(slack?.channels, {}, "Slack no-send proof must not authorize channel replies");
  assert.ok(
    slack?.groupPolicy === undefined || slack.groupPolicy === "allowlist",
    "Slack no-send proof must not authorize channel groups outside the native allowlist shape",
  );
}

async function arrangeNoSendSlackTopology(context, slack) {
  const topology = await arrangeProductionTopology(context, "dedicated", slack);
  return {
    topology,
    protectedValues: [slack.appToken, slack.botToken, process.env.OPENAI_API_KEY],
  };
}

export {
  arrangeNoSendSlackTopology,
  assertConnectedSlackChecks,
  assertInvalidAuthRejected,
  assertNoSendSlackPrerequisites,
  assertNoSecretMaterial,
  assertUnreachableSlackNotConnected,
  ensureNoSendSlackProxy,
  noSendSlackFixture,
  requiresNoSendSlackInvalid,
  requiresNoSendSlackLive,
  requiresProductionCluster,
  runDiagnostics,
  slackNoSendShapeSummary,
};
