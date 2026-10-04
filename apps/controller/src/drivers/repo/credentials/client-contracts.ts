export interface RepositoryCredentialClientConfiguration {
  readonly gatewayOrigin: string;
  readonly gitRemote: string;
  readonly gitUsername: string;
  readonly canonicalApiHost: string;
  readonly apiHost: string;
  readonly repository: string;
  readonly pushRefAllowlist?: readonly string[];
}

/** True when `value` contains a C0 control character (U+0000-U+001F) or DEL (U+007F). */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Git's branch refname rules (check-ref-format) for one concrete `refs/heads/` ref. */
export function isWellFormedBranchRef(ref: string): boolean {
  return (
    ref.startsWith("refs/heads/") &&
    ref.length > "refs/heads/".length &&
    !hasControlCharacter(ref) &&
    !ref.includes(" ") &&
    !/[~^:?*[\\]/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.endsWith(".") &&
    ref
      .split("/")
      .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const c1Control = /[\u0080-\u009f]/u;

/**
 * A pushed destination ref exactly as Git sent its bytes, or undefined. It must be strict
 * UTF-8 without control characters (C0, DEL or C1) and a branch name Git's refname rules
 * accept. Nothing is normalized (no Unicode composition, no case folding), so comparing the
 * result with the allowlist stays an exact byte match and a lookalike spelling never
 * matches an entry. Other characters Git accepts, including format characters such as
 * U+202E, are admitted as the exact bytes sent.
 */
export function decodePushedBranchRef(bytes: Uint8Array): string | undefined {
  let ref: string;
  try {
    ref = strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
  return isWellFormedBranchRef(ref) && !c1Control.test(ref) ? ref : undefined;
}

/** True when `value` has no lone UTF-16 surrogate, so it has one exact UTF-8 spelling. */
function isWellFormedUnicode(value: string): boolean {
  return strictUtf8.decode(new TextEncoder().encode(value)) === value;
}

/** Canonical nonsecret native-push policy. Git refs remain case-sensitive. */
export function normalizePushRefAllowlist(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid-push-ref-allowlist");
  }
  const entries = value.map((entry: unknown) => {
    if (typeof entry !== "string") {
      throw new Error("invalid-push-ref-allowlist");
    }
    const ref = entry.endsWith("/*") ? entry.slice(0, -1) + "branch" : entry;
    // An entry with a lone surrogate could never match a pushed ref; refuse it.
    if (!isWellFormedBranchRef(ref) || !isWellFormedUnicode(ref)) {
      throw new Error("invalid-push-ref-allowlist");
    }
    return entry;
  });
  return Object.freeze([...new Set(entries)].sort());
}

export function allowsPushRef(allowlist: readonly string[], ref: string): boolean {
  return (
    ref.startsWith("refs/heads/") &&
    allowlist.some((entry) =>
      entry.endsWith("/*") ? ref.startsWith(entry.slice(0, -1)) : ref === entry,
    )
  );
}
