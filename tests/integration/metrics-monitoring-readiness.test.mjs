import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  checkGrafanaDatasource,
  queryPrometheus,
  waitForMonitoring,
} from "../helpers/metrics-monitoring-readiness.mjs";

async function loopbackServer(t, respond) {
  const server = createServer(respond);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("datasource readiness retries a transient HTTP 400", async (t) => {
  let attempts = 0;
  // A provisioned datasource may answer before its backend is healthy.
  const origin = await loopbackServer(t, (_request, response) => {
    attempts += 1;
    response.writeHead(attempts === 1 ? 400 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: attempts === 1 ? "ERROR" : "OK" }));
  });

  await waitForMonitoring("grafana-datasource", () => checkGrafanaDatasource(origin), []);
  assert.equal(attempts, 2);
});

test("a timed-out Prometheus response body retries and accepts a later valid query", async (t) => {
  let attempts = 0;
  // Send successful headers, then leave the first body incomplete until fetch times out.
  const origin = await loopbackServer(t, (_request, response) => {
    attempts += 1;
    response.writeHead(200, { "content-type": "application/json" });
    if (attempts === 1) {
      response.flushHeaders();
      return;
    }
    response.end(JSON.stringify({ status: "success", data: { result: [{ value: [0, "1"] }] } }));
  });

  await waitForMonitoring(
    "prometheus-up",
    async () => (await queryPrometheus(origin, "prometheus-up", "up")).length === 1,
    [],
  );
  assert.equal(attempts, 2);
});

test("malformed Prometheus responses remain query errors", async (t) => {
  const origin = await loopbackServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("invalid json");
  });

  await assert.rejects(queryPrometheus(origin, "prometheus-up", "up"), {
    openclawCiDiagnostic: {
      kind: "metrics-monitoring",
      stage: "prometheus-up",
      reason: "query-error",
      lastHttpStatus: 200,
    },
  });
});
