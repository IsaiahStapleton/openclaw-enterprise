import assert from "node:assert/strict";
import test from "node:test";
import {
  clientAddressConfiguration,
  resolveClientAddress,
} from "../../apps/controller/src/auth/client-address.ts";

test("trusted proxy settings are off unless configured and refuse misconfiguration", () => {
  assert.equal(clientAddressConfiguration({}), undefined);
  const refused = [
    [{ OCC_AUTH_TRUSTED_PROXY_PRESET: "aws" }, /require OCC_AUTH_TRUSTED_PROXY_CIDRS/],
    [{ OCC_AUTH_CLIENT_IP_HEADER: "x-real-ip" }, /require OCC_AUTH_TRUSTED_PROXY_CIDRS/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: " " }, /require OCC_AUTH_TRUSTED_PROXY_CIDRS/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8," }, /comma-separated list/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/33" }, /invalid CIDR: 10\.0\.0\.0\/33/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8/1" }, /invalid CIDR/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0/8" }, /invalid CIDR/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "ingress.example.test" }, /invalid CIDR/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/x" }, /invalid CIDR/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "0.0.0.0/0" }, /must not trust every address/],
    [{ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8,::/0" }, /must not trust every address/],
    [
      { OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8", OCC_AUTH_TRUSTED_PROXY_PRESET: "nginx" },
      /must be one of ingress-nginx, aws, generic/,
    ],
    [
      { OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8", OCC_AUTH_TRUSTED_PROXY_PRESET: "generic" },
      /generic trusted proxy preset requires OCC_AUTH_CLIENT_IP_HEADER/,
    ],
    [
      { OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8", OCC_AUTH_CLIENT_IP_HEADER: "x-real-ip" },
      /ingress-nginx trusted proxy preset reads x-forwarded-for/,
    ],
  ];
  for (const header of [
    "X-Forwarded-For",
    "x forwarded",
    "x-occ-client-ip",
    "cookie",
    "forwarded",
  ]) {
    refused.push([
      {
        OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
        OCC_AUTH_TRUSTED_PROXY_PRESET: "generic",
        OCC_AUTH_CLIENT_IP_HEADER: header,
      },
      /OCC_AUTH_CLIENT_IP_HEADER must/,
    ]);
  }
  for (const [environment, message] of refused) {
    assert.throws(
      () => clientAddressConfiguration(environment),
      message,
      JSON.stringify(environment),
    );
  }
});

test("presets fix the client-address header; generic names its own", () => {
  const nginx = clientAddressConfiguration({ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.42.0.0/16" });
  assert.equal(nginx.preset, "ingress-nginx");
  assert.equal(nginx.header, "x-forwarded-for");
  const aws = clientAddressConfiguration({
    OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/16, 2600:1f18::/40",
    OCC_AUTH_TRUSTED_PROXY_PRESET: "aws",
    OCC_AUTH_CLIENT_IP_HEADER: "x-forwarded-for",
  });
  assert.deepEqual(
    [aws.preset, aws.header, aws.cidrs],
    ["aws", "x-forwarded-for", ["10.0.0.0/16", "2600:1f18::/40"]],
  );
  assert.equal(aws.trusts("10.0.200.1"), true);
  assert.equal(aws.trusts("::ffff:10.0.200.1"), true);
  assert.equal(aws.trusts("2600:1f18::1"), true);
  assert.equal(aws.trusts("10.1.0.1"), false);
  assert.equal(aws.trusts("not-an-address"), false);
  const generic = clientAddressConfiguration({
    OCC_AUTH_TRUSTED_PROXY_CIDRS: "192.0.2.10",
    OCC_AUTH_TRUSTED_PROXY_PRESET: "generic",
    OCC_AUTH_CLIENT_IP_HEADER: "x-real-ip",
  });
  assert.equal(generic.header, "x-real-ip");
  assert.equal(generic.trusts("192.0.2.10"), true);
  assert.equal(generic.trusts("192.0.2.11"), false);
});

test("the client address comes only from a trusted peer, walking right to left", () => {
  const config = clientAddressConfiguration({ OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/24" });
  const cases = [
    // Unconfigured or untrusted peers never read the header.
    [undefined, "10.0.0.9", "1.2.3.4", "10.0.0.9"],
    [config, "192.0.2.7", "1.2.3.4", "192.0.2.7"],
    [config, "::ffff:192.0.2.7", "1.2.3.4", "192.0.2.7"],
    // A client-supplied prefix is skipped: the proxy appended the address it saw.
    [config, "10.0.0.9", "6.6.6.6, 1.2.3.4", "1.2.3.4"],
    [config, "::ffff:10.0.0.9", "1.2.3.4, 10.0.0.8, 10.0.0.9", "1.2.3.4"],
    [config, "10.0.0.9", ["6.6.6.6", "2001:db8::1"], "2001:db8::1"],
    // Missing, malformed or all-trusted values fall back to the peer.
    [config, "10.0.0.9", undefined, "10.0.0.9"],
    [config, "10.0.0.9", "", "10.0.0.9"],
    [config, "10.0.0.9", "1.2.3.4, unknown", "10.0.0.9"],
    [config, "10.0.0.9", "1.2.3.4:5678", "10.0.0.9"],
    [config, "10.0.0.9", "10.0.0.1, 10.0.0.2", "10.0.0.9"],
  ];
  for (const [configuration, peer, header, expected] of cases) {
    assert.equal(
      resolveClientAddress(configuration, peer, header),
      expected,
      JSON.stringify({ peer, header }),
    );
  }
});
