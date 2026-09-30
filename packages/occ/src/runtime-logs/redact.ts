/**
 * Best-effort credential masking for runtime log text. Every retained string passes
 * through `redactRuntimeLogText`. A match is replaced whole by `[redacted:<pattern>]`:
 * no leading or trailing characters of a secret survive.
 */

const MARK = "[redacted:";
const notRedacted = "(?!\\[redacted:)";

// Key names whose values are credentials. Plural and compound forms match too
// (`github_token`, `clientSecret`, `x-api-key`); bare `pass` and `auth` do not,
// because they match ordinary words such as `passed` and `author`.
const SECRET_KEY =
  "[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passphrase|pwd|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key|client[_-]?secret|access[_-]?key|signature)[A-Za-z0-9_.-]*";

const HEADER_NAMES = "authorization|proxy-authorization|cookie|set-cookie|x-api-key";

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

const mark = (name: string) => `${MARK}${name}]`;

function redactUrl(url: string): string {
  let rest = url;
  let fragment = "";
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    fragment = `#${mark("fragment")}`;
    rest = rest.slice(0, hash);
  }
  const question = rest.indexOf("?");
  if (question === -1) {
    return rest + fragment;
  }
  const base = rest.slice(0, question);
  const query = rest
    .slice(question + 1)
    .split("&")
    .map((pair) => {
      if (pair.length === 0) {
        return pair;
      }
      const equals = pair.indexOf("=");
      // A bare query token can itself be a credential; keep only well-formed key names.
      if (equals === -1) {
        return mark("query");
      }
      const key = pair.slice(0, equals);
      return /^[A-Za-z0-9_.[\]-]{1,64}$/.test(key) ? `${key}=${mark("query")}` : mark("query");
    })
    .join("&");
  return `${base}?${query}${fragment}`;
}

const RULES: readonly Rule[] = [
  {
    name: "pem",
    pattern: /-----BEGIN [A-Z0-9 ]{0,64}-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,64}-----|$)/g,
    replace: () => mark("pem"),
  },
  {
    // Header values, including inside `-H '...'` and `--header "..."` arguments and JSON.
    name: "header",
    pattern: new RegExp(
      `\\b(${HEADER_NAMES})("?\\s*[:=]\\s*"?)${notRedacted}[^"'\\r\\n]+`,
      "gi",
    ),
    replace: (_match, name, separator) => `${name}${separator}${mark("header")}`,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
    replace: () => mark("jwt"),
  },
  {
    // URL userinfo: `scheme://user:password@host` and `scheme://token@host`.
    name: "userinfo",
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s@"'<>]+@/gi,
    replace: (_match, scheme) => `${scheme}${mark("userinfo")}@`,
  },
  {
    name: "token",
    pattern:
      /\b(?:sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abpr]-|xapp-|glpat-|npm_)[A-Za-z0-9_-]{8,}/g,
    replace: () => mark("token"),
  },
  {
    name: "aws-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => mark("aws-key"),
  },
  {
    name: "google-key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}/g,
    replace: () => mark("google-key"),
  },
  {
    // Every query value and fragment of absolute URLs.
    name: "url",
    pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi,
    replace: (match) => redactUrl(match),
  },
  {
    // Request paths with a query string, as in `GET /hooks?token=...`.
    name: "path-query",
    pattern: /(^|[\s"'(=])(\/[^\s?"'#]*\?[^\s"']*)/g,
    replace: (_match, prefix, path) => `${prefix}${redactUrl(path)}`,
  },
  {
    // `"api_key": "value"` and `"password":value` in embedded JSON.
    name: "key-value",
    pattern: new RegExp(
      `("${SECRET_KEY}"\\s*:\\s*)${notRedacted}("(?:[^"\\\\]|\\\\.)*"|[^\\s,}\\]]+)`,
      "gi",
    ),
    replace: (_match, key) => `${key}"${mark("key-value")}"`,
  },
  {
    // `--password value`, `--token=value`.
    name: "key-value",
    pattern: new RegExp(`(--${SECRET_KEY})(\\s+|=)(?!-)${notRedacted}("[^"]*"|'[^']*'|\\S+)`, "gi"),
    replace: (_match, key, separator) => `${key}${separator}${mark("key-value")}`,
  },
  {
    // `password=value`, `token: value`.
    name: "key-value",
    pattern: new RegExp(
      `\\b(${SECRET_KEY})(\\s*[=:]\\s*)${notRedacted}("[^"]*"|'[^']*'|[^\\s,;&"']+)`,
      "gi",
    ),
    replace: (_match, key, separator) => `${key}${separator}${mark("key-value")}`,
  },
  {
    // Hex and standard base64 runs of 40 or more characters. Slash-separated lowercase
    // paths such as `/api/v1/namespaces/...` are not credential-shaped and stay.
    name: "long-token",
    pattern: /[A-Za-z0-9+/]{40,}={0,2}/g,
    replace: (match) =>
      /^[0-9A-Fa-f]+$/.test(match) || (/[0-9+]/.test(match) && /[A-Z]/.test(match))
        ? mark("long-token")
        : match,
  },
  {
    // base64url runs of 40 or more characters that mix upper case, lower case and digits.
    name: "long-token",
    pattern: /[A-Za-z0-9_-]{40,}/g,
    replace: (match) =>
      /[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)
        ? mark("long-token")
        : match,
  },
];

/** Masks credential-shaped substrings. Input is a single log line or field value. */
export function redactRuntimeLogText(value: string): string {
  let text = value;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, rule.replace as (substring: string, ...args: string[]) => string);
  }
  return text;
}

/** Removes ANSI escape sequences and C0/C1 control characters; tabs become spaces. */
export function stripRuntimeLogControls(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}
