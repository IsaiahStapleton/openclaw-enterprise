import { setTimeout as delay } from "node:timers/promises";

class ResourceCleanupError extends Error {}

// Register before dispatch: a missing creation response never proves that the
// provider did not accept the write. These reads stay inside the admitted repo.
export function registerResourceCleanup(
  cleanups,
  { request, repository, kind, marker, head, issueNumber },
) {
  const prefix = `repos/${repository}`;
  const collection = kind === "comment" ? `issues/${issueNumber}/comments` : kind;
  const reconcile = async (signal) => {
    const matches = [];
    let complete = false;
    for (let page = 1; page <= 5; page++) {
      signal?.throwIfAborted();
      const query = new URLSearchParams({ per_page: "100", page: String(page) });
      if (kind !== "comment") {
        query.set("state", "all");
        query.set("sort", "created");
        query.set("direction", "desc");
      }
      if (head) {
        query.set("head", `${repository.split("/")[0]}:${head}`);
      }
      const values = await request(
        { method: "GET", path: `${prefix}/${collection}?${query}` },
        signal,
      );
      if (!Array.isArray(values)) {
        throw new ResourceCleanupError(`unresolved ${kind} identity: ${marker}`);
      }
      matches.push(
        ...values.filter(
          (value) =>
            typeof value.body === "string" &&
            value.body.split("\n").includes(marker) &&
            (kind !== "issues" || !value.pull_request) &&
            (!head || value.head?.ref === head),
        ),
      );
      if (values.length < 100) {
        complete = true;
        break;
      }
    }
    // Absence after a lost response remains unresolved: provider visibility may
    // lag. Multiple matches or a truncated search also cannot establish ownership.
    if (!complete || matches.length !== 1) {
      throw new ResourceCleanupError(`unresolved ${kind} identity: ${marker}`);
    }
    const value = matches[0];
    const id = kind === "comment" ? value.id : value.number;
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ResourceCleanupError(`unresolved ${kind} identity: ${marker}`);
    }
    const path = `${prefix}/${kind === "comment" ? "issues/comments" : kind}/${id}`;
    if (kind === "comment") {
      await request({ method: "DELETE", path }, signal);
    } else {
      await request({ method: "PATCH", path, body: { state: "closed" } }, signal);
      const closed = await request({ method: "GET", path }, signal);
      if (closed.number !== id || closed.state !== "closed") {
        throw new ResourceCleanupError(`unresolved ${kind} closure: ${marker}`);
      }
    }
  };
  cleanups.push(async (signal) => {
    try {
      await reconcile(signal);
    } catch (error) {
      if (error instanceof ResourceCleanupError) {
        throw error;
      }
      throw new ResourceCleanupError(`unresolved ${kind} cleanup: ${marker}`);
    }
  });
}

export async function closeAndDispose(
  callControl,
  socket,
  sessionId,
  { timeoutMs = 10000, pollMs = 100, signal } = {},
) {
  const deadline = performance.now() + timeoutMs;
  let locallyClosed = false;
  const control = async (request) => {
    try {
      return await callControl(socket, request);
    } catch {
      throw new Error(
        `session cleanup failed: local closure ${locallyClosed ? "confirmed" : "unconfirmed"}; disposal unconfirmed`,
      );
    }
  };
  const inspect = (status) => {
    if (
      !status ||
      typeof status !== "object" ||
      "error" in status ||
      status.sessionId !== sessionId ||
      !["CLOSED", "DISPOSED"].includes(status.state)
    ) {
      throw new Error(
        `session cleanup failed: local closure ${locallyClosed ? "confirmed" : "unconfirmed"}`,
      );
    }
    locallyClosed = true;
    const cleanup = status.cleanup;
    return (
      status.state === "DISPOSED" &&
      status.activeUses === 0 &&
      cleanup &&
      cleanup.active === 0 &&
      cleanup.pending === 0 &&
      cleanup.uncertain === 0 &&
      cleanup.auxiliaryPending === false
    );
  };
  signal?.throwIfAborted();
  inspect(
    await control({
      method: "POST",
      path: `/v1/sessions/${sessionId}/close`,
    }),
  );
  // Always read status, even if close claims immediate disposal.
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    const status = await control({ method: "GET", path: `/v1/sessions/${sessionId}` });
    if (inspect(status) && performance.now() <= deadline) {
      return { localClosure: "confirmed", disposal: "confirmed" };
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - performance.now())), undefined, { signal });
  }
  throw new Error("session cleanup unresolved: local closure confirmed; disposal pending");
}
