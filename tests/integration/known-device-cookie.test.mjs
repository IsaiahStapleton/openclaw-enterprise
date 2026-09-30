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
// Opaque to the cookie; shaped like the password-only profile's state.
const stateOf = (userId, methodVersion) =>
  ["password", userId, "method-1", methodVersion].join("\0");
const accountState = stateOf("user-1", 1);

// Account state by email, recording every read so tests can prove when it is consulted.
function accounts(states = {}) {
  const reads = [];
  const lookup = async (address) => {
    reads.push(address);
    return Object.hasOwn(states, address) ? states[address] : accountState;
  };
  return { lookup, reads };
}
const current = accounts().lookup;
const verify = (value, at = now, target = email, lookup = current, key = secret) =>
  verifyKnownDevice(key, target, value, at, lookup);
const issue = (target, at, existing, state = accountState, key = secret) =>
  issueKnownDevice(key, target, state, at, existing);

test("an issued entry verifies only for its own email and secret", async () => {
  const value = issue(email, now);
  const device = await verify(value, now + 1000);
  assert.ok(device, "the issuing account's email verifies");
  assert.match(device.deviceKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    value,
    /^v2\.[A-Za-z0-9_-]{8}\.[1-9][0-9]*\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/,
  );
  // Emails are normalized the same way sign-in normalizes them.
  assert.deepEqual(await verify(value, now, " Member@Example.TEST "), device);
  // The cookie is bound to its account: it grants nothing to an attempt at another email.
  assert.equal(await verify(value, now, "other@example.test"), undefined);
  // The entry carries neither the email nor the account state.
  assert.equal(value.includes("member"), false);
  assert.equal(value.includes("user-1"), false);
  // Rotating the auth secret invalidates every entry issued under the old one.
  const rotated = "rotated-known-device-secret-at-least-32-bytes";
  assert.equal(await verify(value, now, email, current, rotated), undefined);
});

test("a password change, disable, or recreated account revokes the entry", async () => {
  const value = issue(email, now);
  assert.ok(await verify(value, now + 1000));
  // A password reset bumps the method's authentication version.
  const reset = accounts({ [email]: stateOf("user-1", 2) });
  assert.equal(await verify(value, now + 1000, email, reset.lookup), undefined);
  // A disabled (or deleted, or password-less) account has no state at all.
  const disabled = accounts({ [email]: undefined });
  assert.equal(await verify(value, now + 1000, email, disabled.lookup), undefined);
  // An account deleted and recreated under the same email is a different user.
  const recreated = accounts({ [email]: stateOf("user-2", 1) });
  assert.equal(await verify(value, now + 1000, email, recreated.lookup), undefined);
  // Re-enabling does not bring the old state back in the guarded profile: the account
  // version moved. Only a new sign-in issues an entry for the new state.
  const renewed = issue(email, now + 2000, value, stateOf("user-1", 2));
  assert.equal(renewed.split("~").length, 1, "the stale entry is replaced");
  assert.ok(await verify(renewed, now + 3000, email, reset.lookup));
  assert.equal(await verify(renewed, now + 3000), undefined, "the new entry needs the new state");
});

test("the account is read only for an entry issued for the attempted email", async () => {
  const value = issue(email, now);
  const [version, keyId, issuedAt, nonce, mac, binding] = value.split(".");
  const flipped = (part) => `${part.slice(0, -1)}${part.endsWith("A") ? "B" : "A"}`;
  const { lookup, reads } = accounts();
  for (const candidate of [
    `${version}.${keyId}.${issuedAt}.${nonce}.${flipped(mac)}.${binding}`,
    issue("other@example.test", now),
    `v1.${keyId}.${issuedAt}.${nonce}.${mac}`,
    `v2.AAAAAAAA.${issuedAt}.${"A".repeat(16)}.${"A".repeat(43)}.${"A".repeat(43)}`,
    undefined,
  ]) {
    assert.equal(await verify(candidate, now, email, lookup), undefined, String(candidate));
  }
  // Forged and foreign entries never reach the account, so they add no timing signal
  // about whether an email exists.
  assert.deepEqual(reads, []);
  // A tampered binding reads the account once and still verifies nothing.
  const tampered = `${version}.${keyId}.${issuedAt}.${nonce}.${mac}.${flipped(binding)}`;
  assert.equal(await verify(tampered, now, email, lookup), undefined);
  assert.deepEqual(reads, [email]);
  // Several entries for the email read the account once.
  reads.length = 0;
  assert.ok(await verify(`${tampered}~${value}`, now, email, lookup));
  assert.deepEqual(reads, [email]);
});

test("a failed account read fails safe to the shared lane", async () => {
  const value = issue(email, now);
  const failing = async () => {
    throw new Error("database unavailable");
  };
  assert.equal(await verify(value, now, email, failing), undefined);
});

test("tampered, malformed, expired and future entries do not verify", async () => {
  const value = issue(email, now);
  const [version, keyId, issuedAt, nonce, mac, binding] = value.split(".");
  const flipped = `${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
  const otherNonce = `${nonce.slice(0, -1)}${nonce.endsWith("A") ? "B" : "A"}`;
  for (const candidate of [
    `${version}.${keyId}.${issuedAt}.${nonce}.${flipped}.${binding}`,
    // Moving the issue time forward would extend the lifetime; the MAC covers it.
    `${version}.${keyId}.${Number(issuedAt) + 1}.${nonce}.${mac}.${binding}`,
    // The nonce is signed too, so it cannot be changed to mint another lane.
    `${version}.${keyId}.${issuedAt}.${otherNonce}.${mac}.${binding}`,
    `v3.${keyId}.${issuedAt}.${nonce}.${mac}.${binding}`,
    `${version}.${keyId}.${issuedAt}.${nonce}.${mac}`,
    `${version}.${keyId}.${issuedAt}.${mac}.${binding}`,
    "",
    undefined,
    `${value}~${"x".repeat(600)}`,
  ]) {
    assert.equal(await verify(candidate), undefined, String(candidate));
  }
  const lifetime = KNOWN_DEVICE_LIFETIME_SECONDS * 1000;
  assert.ok(await verify(value, now + lifetime - 1000));
  assert.equal(await verify(value, now + lifetime), undefined);
  // An entry issued well ahead of this controller's clock is not accepted.
  const ahead = issue(email, now + 3_600_000);
  assert.equal(await verify(ahead), undefined);
});

test("two browsers signing in to one account in the same second get distinct lanes", async () => {
  const first = issue(email, now);
  const second = issue(email, now + 999);
  assert.equal(first.split(".")[2], second.split(".")[2], "same issue second");
  assert.notEqual(first, second);
  const a = await verify(first, now + 1000);
  const b = await verify(second, now + 1000);
  assert.ok(a && b);
  assert.notEqual(a.deviceKey, b.deviceKey);
});

test("a cookie holding several entries for one email selects one lane per request", async () => {
  // A legitimate browser never holds two entries for one email (issuing replaces them);
  // a crafted cookie that does still selects exactly one lane, the first matching entry.
  // Each captured entry is its own bounded lane, never a session.
  const snapshots = [0, 1, 2].map((index) => issue(email, now + index * 1000));
  const lanes = await Promise.all(snapshots.map((value) => verify(value, now + 5000)));
  assert.equal(new Set(lanes.map((lane) => lane.deviceKey)).size, 3);
  assert.deepEqual(await verify(snapshots.join("~"), now + 5000), lanes[0]);
  assert.deepEqual(await verify([...snapshots].reverse().join("~"), now + 5000), lanes[2]);
  // Issuing from such a cookie collapses it back to the one fresh entry for this email.
  const reissued = issue(email, now + 6000, snapshots.join("~"));
  assert.equal(reissued.split("~").length, 1);
});

test("a browser keeps entries for its three most recent accounts", async () => {
  let value;
  const accountEmails = ["a@example.test", "b@example.test", "c@example.test", "d@example.test"];
  for (const [index, account] of accountEmails.entries()) {
    value = issue(account, now + index * 1000, value);
  }
  assert.equal(value.split("~").length, 3);
  assert.equal(await verify(value, now + 5000, "a@example.test"), undefined);
  for (const account of accountEmails.slice(1)) {
    assert.ok(await verify(value, now + 5000, account), account);
  }
  // Signing in again replaces the account's entry instead of adding a duplicate, and the
  // new entry is a new device lane.
  const before = await verify(value, now + 5000, "c@example.test");
  const again = issue("c@example.test", now + 10_000, value);
  assert.equal(again.split("~").length, 3);
  const after = await verify(again, now + 10_000, "c@example.test");
  assert.notEqual(after.deviceKey, before.deviceKey);
  assert.ok(await verify(again, now + 10_000, "b@example.test"));
  // A sign-in after secret rotation drops the entries the old secret signed.
  const rotated = "rotated-known-device-secret-at-least-32-bytes";
  const fresh = issue("b@example.test", now + 20_000, again, accountState, rotated);
  assert.equal(fresh.split("~").length, 1);
  assert.ok(await verify(fresh, now + 20_000, "b@example.test", current, rotated));
});

test("three entries fit the cookie", async () => {
  let value;
  for (const [index, account] of ["a@example.test", "b@example.test", "c@example.test"].entries()) {
    value = issue(account, now + index * 1000, value, "x".repeat(200));
  }
  assert.ok(value.length <= 512, `length ${value.length}`);
  assert.equal(knownDeviceFromCookieHeader(`__Host-occ_known_device=${value}`, true), value);
});

test("the cookie is host-only, HttpOnly, SameSite=Strict and read only when unambiguous", () => {
  const value = issue(email, now);
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
