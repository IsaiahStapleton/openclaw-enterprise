import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Known-device cookie (OWASP "device cookie"). A successful sign-in marks the browser as a
 * known device for that account's email. On a later password attempt for the same email,
 * a valid entry moves the attempt from the shared per-email budget to the device's own
 * budget, so strangers spending the email's budget cannot keep the account's own browser
 * out. The cookie never authenticates and never selects an account: it only chooses which
 * admission lane an attempt for the email it names spends.
 *
 * Each entry is `v1.<keyId>.<issuedAt seconds>.<nonce>.<mac>`, where the MAC is keyed by the
 * auth secret and covers a hash of the normalized email, the issue time and a random
 * per-issue nonce (so two browsers signing in to one account in the same second still get
 * distinct entries and lanes); `keyId` is a short, non-reversible fingerprint of that
 * secret. No entry carries the email. Rotating the auth secret invalidates every entry:
 * browsers fall back to the shared lane until their next successful sign-in, which issues a
 * fresh entry under the new secret and drops the entries the old secret signed.
 * Up to three entries (the most recent accounts signed in from the browser) are joined
 * with `~`.
 */
export const KNOWN_DEVICE_LIFETIME_SECONDS = 90 * 86_400;

const maxEntries = 3;
const maxCookieLength = 512;
// Entries issued slightly ahead of this controller's clock (another replica, clock steps)
// are still accepted; anything further ahead is not.
const futureSkewSeconds = 300;
const nonceBytes = 12;
const entryPattern =
  /^v1\.([A-Za-z0-9_-]{8})\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;

export function knownDeviceCookieName(secure: boolean): string {
  // __Host- requires Secure, Path=/ and no Domain, so a sibling host cannot plant one.
  return secure ? "__Host-occ_known_device" : "occ_known_device";
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function keyId(secret: string): string {
  return createHmac("sha256", secret)
    .update("occ-known-device-key")
    .digest("base64url")
    .slice(0, 8);
}

function entryMac(secret: string, email: string, issuedAt: number, nonce: string): string {
  const emailHash = createHash("sha256").update(normalizedEmail(email)).digest("hex");
  return createHmac("sha256", secret)
    .update(`occ-known-device\0${emailHash}\0${issuedAt}\0${nonce}`)
    .digest("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Entry {
  readonly raw: string;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly nonce: string;
  readonly mac: string;
}

function currentEntries(value: string | undefined, now: number): Entry[] {
  if (value === undefined || value.length === 0 || value.length > maxCookieLength) {
    return [];
  }
  const nowSeconds = Math.floor(now / 1000);
  const entries: Entry[] = [];
  for (const raw of value.split("~").slice(0, maxEntries)) {
    const match = entryPattern.exec(raw);
    if (match === null) {
      continue;
    }
    const issuedAt = Number(match[2]);
    if (
      issuedAt > nowSeconds + futureSkewSeconds ||
      nowSeconds - issuedAt >= KNOWN_DEVICE_LIFETIME_SECONDS
    ) {
      continue;
    }
    entries.push({ raw, keyId: match[1]!, issuedAt, nonce: match[3]!, mac: match[4]! });
  }
  return entries;
}

function matches(secret: string, email: string, entry: Entry): boolean {
  return (
    entry.keyId === keyId(secret) &&
    equal(entryMac(secret, email, entry.issuedAt, entry.nonce), entry.mac)
  );
}

/**
 * The known-device identity for `email`, or undefined when the cookie holds no current,
 * untampered entry issued for that email under this secret. `deviceKey` is opaque and
 * distinct per issued entry (the MAC covers a random nonce); admission hashes it before use.
 * One request selects at most one lane: the first matching entry.
 */
export function verifyKnownDevice(
  secret: string,
  email: string,
  cookieValue: string | undefined,
  now: number,
): { readonly deviceKey: string } | undefined {
  for (const entry of currentEntries(cookieValue, now)) {
    if (matches(secret, email, entry)) {
      return { deviceKey: entry.mac };
    }
  }
  return undefined;
}

/**
 * The cookie value after a successful sign-in for `email`: a fresh entry first, then up to
 * two current entries for other accounts from the existing value. Entries for this email
 * are replaced, never duplicated; entries signed under a rotated-out secret are dropped.
 */
export function issueKnownDevice(
  secret: string,
  email: string,
  now: number,
  existing?: string,
): string {
  const issuedAt = Math.floor(now / 1000);
  const currentKey = keyId(secret);
  const nonce = randomBytes(nonceBytes).toString("base64url");
  const fresh = `v1.${currentKey}.${issuedAt}.${nonce}.${entryMac(secret, email, issuedAt, nonce)}`;
  const others = currentEntries(existing, now)
    .filter((entry) => entry.keyId === currentKey && !matches(secret, email, entry))
    .map((entry) => entry.raw);
  return [fresh, ...others].slice(0, maxEntries).join("~");
}

/** Cookie attributes shared by both sign-in profiles. */
export function knownDeviceCookieAttributes(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/",
    maxAge: KNOWN_DEVICE_LIFETIME_SECONDS,
  };
}

/** A complete Set-Cookie header value for the password-only profile's Fastify route. */
export function knownDeviceSetCookie(secure: boolean, value: string): string {
  const attributes = knownDeviceCookieAttributes(secure);
  return [
    `${knownDeviceCookieName(secure)}=${value}`,
    `Max-Age=${attributes.maxAge}`,
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Strict",
  ].join("; ");
}

/**
 * Reads the known-device cookie from a Cookie header. A missing, duplicated, or oversized
 * cookie reads as absent, so ambiguity only ever returns an attempt to the shared lane.
 */
export function knownDeviceFromCookieHeader(
  header: string | readonly string[] | null | undefined,
  secure: boolean,
): string | undefined {
  const name = knownDeviceCookieName(secure);
  const joined = typeof header === "string" ? header : (header ?? []).join("; ");
  let found: string | undefined;
  for (const part of joined.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    if (found !== undefined) {
      return undefined;
    }
    found = part.slice(separator + 1).trim();
  }
  return found !== undefined && found.length <= maxCookieLength ? found : undefined;
}
