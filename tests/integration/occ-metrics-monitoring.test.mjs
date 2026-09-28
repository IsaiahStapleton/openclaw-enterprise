import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { startMetricsListener } from "../../apps/controller/src/metrics/listener.ts";

const run = promisify(execFile);
const engine = process.env.OCC_METRICS_TEST_ENGINE ?? "docker";
const prometheusImage =
  "docker.io/prom/prometheus@sha256:5ce7540c3c00ef4ab0c9d2c995c6a5b9c421f44b4a115d97a2c7af3b1c21cbb0";
const grafanaImage =
  "docker.io/grafana/grafana@sha256:ac461fb352abc50da10a51c7d02462e9c05488f11f53f14b3ad79a8145f638a0";

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

function monitoringFailure(stage, reason, details = {}) {
  const error = new Error(`Monitoring ${stage} failed: ${reason}`);
  error.openclawCiDiagnostic = { kind: "metrics-monitoring", stage, reason, ...details };
  return error;
}

async function containerState(name) {
  const { stdout } = await run(engine, ["inspect", "--format", "{{json .State}}", name]);
  return JSON.parse(stdout);
}

async function waitFor(stage, read, containers) {
  const end = Date.now() + 60_000;
  let lastHttpStatus;
  while (Date.now() < end) {
    // A detached container can exit successfully from `run -d` before its
    // listener binds; waiting for a scrape would hide that setup failure.
    for (const [role, name] of containers) {
      let state;
      try {
        state = await containerState(name);
      } catch {
        throw monitoringFailure(stage, "query-error", { container: role, lastHttpStatus });
      }
      if (!state.Running) {
        throw monitoringFailure(stage, "container-exited", {
          container: role,
          exitCode: state.ExitCode,
          lastHttpStatus,
        });
      }
    }
    try {
      if (await read()) {
        return;
      }
    } catch (error) {
      if (error.openclawCiDiagnostic?.reason === "query-error") {
        throw error;
      }
      const connectionError = ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(
        error.cause?.code,
      );
      const serverError = error.httpStatus >= 500 && error.httpStatus <= 599;
      const datasourceProvisioning = stage === "grafana-datasource" && error.httpStatus === 404;
      if (
        !connectionError &&
        error.name !== "TimeoutError" &&
        !serverError &&
        !datasourceProvisioning
      ) {
        throw error;
      }
      // These outcomes can occur while the listeners and provisioning start.
      lastHttpStatus = error.httpStatus ?? lastHttpStatus;
    }
    await delay(500);
  }
  throw monitoringFailure(stage, "timeout", { lastHttpStatus });
}

test(
  "Prometheus remote write records real OCC traffic and Grafana provisions its dashboard",
  {
    skip:
      process.env.OCC_TEST_METRICS_MONITORING !== "1"
        ? "Set OCC_TEST_METRICS_MONITORING=1 with a Linux container runtime."
        : false,
    timeout: 180_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "occ-metrics-monitoring-"));
    const names = [];
    t.after(async () => {
      for (const [role, name] of names.reverse()) {
        if (!t.passed) {
          const logs = await run(engine, ["logs", "--tail=20", name]).catch(() => ({
            stdout: "",
            stderr: "",
          }));
          t.diagnostic(`${role}: ${logs.stdout}${logs.stderr}`);
        }
        await run(engine, ["rm", "-f", "-v", name]);
      }
      await rm(directory, { recursive: true, force: true });
    });
    const metrics = createOccMetrics("api");
    const fixture = await createConsoleAppFixture(t, { metrics });
    const listener = await startMetricsListener(metrics, { host: "127.0.0.1", port: 0 });
    t.after(() => listener.close());
    await fixture.bootstrap();
    // Select each candidate port as late as possible; Docker still owns the
    // final bind, so an exited container is reported by the readiness wait.
    const promPort = await port();
    const promURL = `http://127.0.0.1:${promPort}`;
    await writeFile(
      join(directory, "prometheus.yaml"),
      await readFile("deploy/metrics/development/prometheus.yaml"),
    );
    const agentConfig = (await readFile("deploy/metrics/development/api.yaml", "utf8"))
      .replace("127.0.0.1:9464", listener.url.slice(7))
      .replace("http://prometheus:9090", promURL);
    await writeFile(join(directory, "agent.yaml"), agentConfig);
    await mkdir(join(directory, "provisioning", "datasources"), { recursive: true });
    await mkdir(join(directory, "provisioning", "dashboards"), { recursive: true });
    await mkdir(join(directory, "dashboards"));
    await writeFile(
      join(directory, "provisioning", "datasources", "occ.yaml"),
      (await readFile("deploy/metrics/development/grafana/datasources/occ.yaml", "utf8")).replace(
        "http://prometheus:9090",
        promURL,
      ),
    );
    await writeFile(
      join(directory, "provisioning", "dashboards", "occ.yaml"),
      (await readFile("deploy/metrics/development/grafana/dashboards/occ.yaml", "utf8")).replace(
        "/etc/occ-dashboard",
        "/etc/occ-test/dashboards",
      ),
    );
    await writeFile(
      join(directory, "dashboards", "occ.json"),
      await readFile("deploy/helm/openclaw-observability-demo/files/dashboard.json"),
    );

    async function container(role, image, args, extra = []) {
      const name = `occ-metrics-${role}-${randomUUID().slice(0, 8)}`;
      names.push([role, name]);
      await run(
        engine,
        [
          "run",
          "-d",
          "--name",
          name,
          "--network",
          "host",
          ...(engine === "podman" ? ["--userns=keep-id"] : []),
          "--user",
          `${process.getuid()}:${process.getgid()}`,
          "--security-opt",
          "label=disable",
          "-v",
          `${directory}:/etc/occ-test:ro`,
          ...extra,
          image,
          ...args,
        ],
        { timeout: 60_000 },
      );
      return name;
    }
    // Containers use host networking solely to reach this test's real loopback
    // listener. The checked-in Compose overlay instead shares OCC namespaces.
    const server = await container(
      "server",
      prometheusImage,
      [
        "--config.file=/etc/occ-test/prometheus.yaml",
        "--web.enable-remote-write-receiver",
        `--web.listen-address=127.0.0.1:${promPort}`,
        "--storage.tsdb.path=/tmp/prometheus",
      ],
      ["--tmpfs", "/tmp:rw,mode=1777"],
    );
    const agentPort = await port();
    const agent = await container(
      "agent",
      prometheusImage,
      [
        "--agent",
        "--config.file=/etc/occ-test/agent.yaml",
        `--web.listen-address=127.0.0.1:${agentPort}`,
        "--storage.agent.path=/tmp/agent",
      ],
      ["--tmpfs", "/tmp:rw,mode=1777"],
    );
    const query = async (stage, expression) => {
      const response = await fetch(
        `${promURL}/api/v1/query?query=${encodeURIComponent(expression)}`,
        { signal: AbortSignal.timeout(3_000) },
      );
      if (!response.ok) {
        if (response.status < 500) {
          throw monitoringFailure(stage, "query-error", { lastHttpStatus: response.status });
        }
        const error = new Error(`Prometheus query returned HTTP ${response.status}`);
        error.httpStatus = response.status;
        throw error;
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw monitoringFailure(stage, "query-error", { lastHttpStatus: response.status });
      }
      if (body.status !== "success" || !Array.isArray(body.data?.result)) {
        throw monitoringFailure(stage, "query-error", { lastHttpStatus: response.status });
      }
      return body.data.result;
    };
    await waitFor(
      "prometheus-up",
      async () =>
        (await query("prometheus-up", 'up{job="occ-api"}')).some(
          (series) => series.value[1] === "1",
        ),
      [
        ["server", server],
        ["agent", agent],
      ],
    );
    await fixture.request("GET", "/installation");
    await waitFor(
      "occ-request",
      async () =>
        (
          await query(
            "occ-request",
            'sum(occ_http_requests_total{route="/installation",method="GET"})',
          )
        ).some((series) => Number(series.value[1]) >= 1),
      [
        ["server", server],
        ["agent", agent],
      ],
    );
    const dashboard = JSON.parse(
      await readFile("deploy/helm/openclaw-observability-demo/files/dashboard.json", "utf8"),
    );
    // Every shipped panel must be valid PromQL, even when a quiet/absent worker
    // has no samples. A real server, not a string matcher, checks the queries.
    for (const panel of dashboard.panels) {
      await query("occ-request", panel.targets[0].expr);
    }

    const grafanaPort = await port();
    const grafana = await container(
      "grafana",
      grafanaImage,
      [],
      [
        "--tmpfs",
        "/var/lib/grafana:rw,noexec,mode=1777",
        "--tmpfs",
        "/var/log/grafana:rw,mode=1777",
        "-e",
        "GF_PATHS_PROVISIONING=/etc/occ-test/provisioning",
        "-e",
        "GF_SERVER_HTTP_ADDR=127.0.0.1",
        "-e",
        `GF_SERVER_HTTP_PORT=${grafanaPort}`,
        "-e",
        "GF_AUTH_ANONYMOUS_ENABLED=true",
        "-e",
        "GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer",
        "-e",
        "GF_ANALYTICS_REPORTING_ENABLED=false",
        "-e",
        "GF_ANALYTICS_CHECK_FOR_UPDATES=false",
        // Keep the image's bundled plugins. Background updates replace running
        // backends with downloads that cannot execute from the data tmpfs.
        "-e",
        "GF_PLUGINS_PREINSTALL_DISABLED=true",
      ],
    );
    await waitFor(
      "grafana-health",
      async () => {
        const response = await fetch(`http://127.0.0.1:${grafanaPort}/api/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) {
          const error = new Error(`Grafana health returned HTTP ${response.status}`);
          error.httpStatus = response.status;
          throw error;
        }
        return true;
      },
      [["grafana", grafana]],
    );
    const provisioned = await fetch(
      `http://127.0.0.1:${grafanaPort}/api/dashboards/uid/occ-development`,
    ).then((response) => response.json());
    assert.equal(provisioned.dashboard.uid, "occ-development");
    assert.deepEqual(provisioned.dashboard.panels, dashboard.panels);
    // Grafana's HTTP listener can be ready before its datasource backend. Wait
    // for the actual Grafana-to-Prometheus query to succeed within the same bound.
    await waitFor(
      "grafana-datasource",
      async () => {
        const response = await fetch(
          `http://127.0.0.1:${grafanaPort}/api/datasources/uid/occ-prometheus/health`,
          { signal: AbortSignal.timeout(3_000) },
        );
        if (!response.ok) {
          const error = new Error(`Grafana datasource returned HTTP ${response.status}`);
          error.httpStatus = response.status;
          throw error;
        }
        const datasource = await response.json();
        return datasource.status === "OK";
      },
      [
        ["grafana", grafana],
        ["server", server],
      ],
    );
  },
);
