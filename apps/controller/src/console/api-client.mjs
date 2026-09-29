export function createApiClient({ lifetime, hasSession, onExpired, sessionKey = () => null }) {
  async function request(path, { method = "GET", body, signal, expectedStatus } = {}) {
    const active = lifetime.capture();
    const pinned = sessionKey();
    // A pinned key lets this tab act only as its own session. If another tab
    // replaces the shared cookie, the controller answers 401 instead.
    const headers = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(pinned ? { "x-occ-session-key": pinned } : {}),
    };
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.any([
        lifetime.signal,
        ...(signal ? [signal] : []),
        AbortSignal.timeout(15_000),
      ]),
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Expiry invalidates the whole view, including other reads or saves still pending.
    if (response.status === 401 && hasSession() && lifetime.isCurrent(active)) {
      onExpired();
    }
    if (response.status === 204 && response.ok && expectedStatus === 204) {
      return undefined;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (
      !response.ok ||
      (expectedStatus !== undefined && response.status !== expectedStatus) ||
      payload === null ||
      !Object.hasOwn(payload, "data")
    ) {
      const error = new Error("The request could not be completed.");
      error.status = response.status;
      const code = payload?.error?.code;
      if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
        error.code = code;
      }
      const requestId = payload?.meta?.requestId;
      if (
        typeof requestId === "string" &&
        /^req_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestId)
      ) {
        error.requestId = requestId;
      }
      throw error;
    }
    return payload.data;
  }

  return request;
}
