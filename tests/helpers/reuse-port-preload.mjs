// Preloaded into a test's Node child process (see reservedPortChild in available-port.mjs).
// A listen() on a port named in OPENCLAW_TEST_REUSE_PORTS also sets `reusePort`, so the
// child can bind a port its parent test still holds with reservePort(). Every other
// listen() is unchanged.
import net from "node:net";

const ports = new Set(
  (process.env.OPENCLAW_TEST_REUSE_PORTS ?? "")
    .split(",")
    .filter((port) => /^[1-9][0-9]*$/.test(port))
    .map(Number),
);
const listen = net.Server.prototype.listen;

net.Server.prototype.listen = function listenWithReservedPort(...args) {
  const [first] = args;
  if (first !== null && typeof first === "object" && ports.has(Number(first.port))) {
    args[0] = { ...first, reusePort: true };
  } else if (typeof first === "number" && ports.has(first)) {
    // listen(port[, host][, backlog][, callback])
    const [port, ...rest] = args;
    const options = { port, reusePort: true };
    if (typeof rest[0] === "string") {
      options.host = rest.shift();
    }
    if (typeof rest[0] === "number") {
      options.backlog = rest.shift();
    }
    args = [options, ...rest];
  }
  return listen.apply(this, args);
};
