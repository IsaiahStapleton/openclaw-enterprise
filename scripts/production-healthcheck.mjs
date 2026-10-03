import { stat } from "node:fs/promises";

try {
  if (process.argv[2] !== "worker") {
    throw new Error("Only worker health requires an exec probe.");
  }
  const marker = process.env.OCC_WORKER_READINESS_PATH;
  if (typeof marker !== "string" || !marker.startsWith("/")) {
    throw new Error("The worker readiness marker must be an explicit absolute path.");
  }
  const observed = await stat(marker);
  const poll = Number(process.env.OCC_WORKER_POLL_INTERVAL_MS ?? "250");
  const lease = Number(process.env.OCC_WORKER_LEASE_DURATION_MS ?? "5000");
  if (process.argv[3] === "ready") {
    if (Date.now() - observed.mtimeMs > Math.max(15_000, poll * 60, lease * 3)) {
      throw new Error("The worker has not reported a recent healthy database observation.");
    }
  } else if (process.env.OCC_WORKER_LIVENESS_PATH !== undefined) {
    // Liveness asks only whether the run loop still moves. A database outage keeps it
    // moving (each pass fails fast); a pass stuck on an await does not. Claim heartbeats,
    // every lease / 3, also count, so a long in-pass Compute wait stays live.
    const progress = process.env.OCC_WORKER_LIVENESS_PATH;
    if (!progress.startsWith("/")) {
      throw new Error("The worker liveness marker must be an explicit absolute path.");
    }
    const moved = await stat(progress);
    if (Date.now() - moved.mtimeMs > Math.max(120_000, poll * 240, lease * 6)) {
      throw new Error("The worker run loop has not made progress recently.");
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Health check failed."}\n`);
  process.exitCode = 1;
}
