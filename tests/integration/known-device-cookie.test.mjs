import assert from "node:assert/strict";
import test from "node:test";
import {
  KNOWN_DEVICE_LIFETIME_SECONDS,
  issueKnownDevice,
  knownDeviceCookieName,
  knownDeviceFromCookieHeader,
  knownDeviceSetCookie,
  verifyKnownDevice,
} from "../../apps/controller/src/auth/known-device.ts";

const secret = "known-device-test-secret-at-least-32-bytes";
const email = "member@example.test";
const now = Date.UTC(2026, 8, 30, 12);

test("an issued entry verifies only for its own email and secret", () => {
  const value = issueKnownDevice(secret, email, now);
  const device = verifyKnownDevice(secret, email, value, now + 1000);
  assert.ok(device, "the issuing account's email verifies");
  assert.match(device.deviceKey, /^[A-Za-z0-9_-]{43}$/);
  // Emails are normalized the same way sign-in normalizes them.
  assert.deepEqual(verifyKnownDevice(secret, " Member@Example.TEST ", value, now), device);
  // The cookie is bound to its account: it grants nothing to an attempt at another email.
  assert.equal(verifyKnownDevice(secret, "other@example.test", value, now), undefined);
  // The entry carries neither the email nor anything derived from it without the secret.
  assert.equal(value.includes("member"), false);
  // Rotating the auth secret invalidates every entry issued under the old one.
  assert.equal(
    verifyKnownDevice("rotated-known-device-secret-at-least-32-bytes", email, value, now),
    undefined,
  );
});

test("tampered, malformed, expired and future entries do not verify", () => {
  const value = issueKnownDevice(secret, email, now);
  const [version, keyId, issuedAt, mac] = value.split(".");
  const flipped = `${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
  for (const candidate of [
    `${version}.${keyId}.${issuedAt}.${flipped}`,
    // Moving the issue time forward would extend the lifetime; the MAC covers it.
    `${version}.${keyId}.${Number(issuedAt) + 1}.${mac}`,
    `v2.${keyId}.${issuedAt}.${mac}`,
    `${version}.${keyId}.${issuedAt}`,
    "",
    undefined,
    `${value}~${"x".repeat(600)}`,
  ]) {
    assert.equal(verifyKnownDevice(secret, email, candidate, now), undefined, String(candidate));
  }
  const lifetime = KNOWN_DEVICE_LIFETIME_SECONDS * 1000;
  assert.ok(verifyKnownDevice(secret, email, value, now + lifetime - 1000));
  assert.equal(verifyKnownDevice(secret, email, value, now + lifetime), undefined);
  // An entry issued well ahead of this controller's clock is not accepted.
  const ahead = issueKnownDevice(secret, email, now + 3_600_000);
  assert.equal(verifyKnownDevice(secret, email, ahead, now), undefined);
});

test("a browser keeps entries for its three most recent accounts", () => {
  let value;
  const accounts = ["a@example.test", "b@example.test", "c@example.test", "d@example.test"];
  for (const [index, account] of accounts.entries()) {
    value = issueKnownDevice(secret, account, now + index * 1000, value);
  }
  assert.equal(value.split("~").length, 3);
  assert.equal(verifyKnownDevice(secret, "a@example.test", value, now + 5000), undefined);
  for (const account of accounts.slice(1)) {
    assert.ok(verifyKnownDevice(secret, account, value, now + 5000), account);
  }
  // Signing in again replaces the account's entry instead of adding a duplicate, and the
  // new entry is a new device lane.
  const before = verifyKnownDevice(secret, "c@example.test", value, now + 5000);
  const again = issueKnownDevice(secret, "c@example.test", now + 10_000, value);
  assert.equal(again.split("~").length, 3);
  const after = verifyKnownDevice(secret, "c@example.test", again, now + 10_000);
  assert.notEqual(after.deviceKey, before.deviceKey);
  assert.ok(verifyKnownDevice(secret, "b@example.test", again, now + 10_000));
  // A sign-in after secret rotation drops the entries the old secret signed.
  const rotated = "rotated-known-device-secret-at-least-32-bytes";
  const fresh = issueKnownDevice(rotated, "b@example.test", now + 20_000, again);
  assert.equal(fresh.split("~").length, 1);
  assert.ok(verifyKnownDevice(rotated, "b@example.test", fresh, now + 20_000));
});

test("the cookie is host-only, HttpOnly, SameSite=Strict and read only when unambiguous", () => {
  const value = issueKnownDevice(secret, email, now);
  assert.equal(knownDeviceCookieName(true), "__Host-occ_known_device");
  const secure = knownDeviceSetCookie(true, value);
  assert.equal(
    secure,
    `__Host-occ_known_device=${value}; Max-Age=${KNOWN_DEVICE_LIFETIME_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  );
  assert.equal(secure.includes("Domain"), false);
  assert.equal(knownDeviceSetCookie(false, value).includes("Secure"), false);

  assert.equal(
    knownDeviceFromCookieHeader(`a=1; __Host-occ_known_device=${value}; b=2`, true),
    value,
  );
  // The non-prefixed name, which a sibling host could plant, is ignored on HTTPS.
  assert.equal(knownDeviceFromCookieHeader(`occ_known_device=${value}`, true), undefined);
  // Two cookies of the same name are ambiguous and read as none.
  assert.equal(
    knownDeviceFromCookieHeader(
      `__Host-occ_known_device=${value}; __Host-occ_known_device=${value}`,
      true,
    ),
    undefined,
  );
  assert.equal(knownDeviceFromCookieHeader(undefined, true), undefined);
});
