import { stripVTControlCharacters } from "node:util";

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
// Affixes are bounded and no rule lets a key start anywhere inside a long run: an
// unbounded `[A-Za-z0-9_.-]*` around the keyword backtracks quadratically on runs such as
// `a-a-a-...`, and the redactor runs synchronously on workload-controlled lines of up to
// 32 KiB. The bare `key=value` rule starts its match at the keyword (the key text before
// it stays in place, exactly as the replacement kept it before).
const KEY_AFFIX = "[A-Za-z0-9_.-]{0,64}";
const SECRET_KEY_TAIL = `(?:token|secret|passw(?:or)?d|passphrase|pwd|api[_-]?key|apikey|authorization|cookie|credential|private[_-]?key|client[_-]?secret|access[_-]?key|signature)${KEY_AFFIX}`;
const SECRET_KEY = `${KEY_AFFIX}${SECRET_KEY_TAIL}`;

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

/**
 * Redacts the query of the first request path in a token. A path starts with `/` at the
 * token start or after `(` or `=`, runs without `?` or `#`, and is followed by `?`.
 * Single pass: every `?`/`#` ends the candidates that precede it.
 */
function redactPathQuery(token: string): string {
  let position = 0;
  for (;;) {
    let stop = position;
    while (stop < token.length && token[stop] !== "?" && token[stop] !== "#") {
      stop += 1;
    }
    if (stop === token.length) {
      return token;
    }
    if (token[stop] === "?") {
      for (let index = position; index < stop; index += 1) {
        if (
          token[index] === "/" &&
          (index === 0 || token[index - 1] === "(" || token[index - 1] === "=")
        ) {
          return token.slice(0, index) + redactUrl(token.slice(index));
        }
      }
    }
    position = stop + 1;
  }
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
    pattern: new RegExp(`\\b(${HEADER_NAMES})("?\\s*[:=]\\s*"?)${notRedacted}[^"'\\r\\n]+`, "gi"),
    replace: (_match, name, separator) => `${name}${separator}${mark("header")}`,
  },
  {
    // `Bearer <token>` and `bearer token <token>` outside a header, whatever the token's
    // length or prefix. Words without a digit (`bearer authentication failed`) stay.
    name: "bearer",
    pattern: /\b(bearer\s+(?:token\s+)?)(?!\[redacted:)([A-Za-z0-9._~+/-]{8,}=*)/gi,
    replace: (match, prefix, value) => (/[0-9]/.test(value) ? `${prefix}${mark("bearer")}` : match),
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
    // Request paths with a query string, as in `GET /hooks?token=...`. The regex only
    // selects whole whitespace- or quote-delimited tokens that contain `?` (the lookbehind
    // anchors each attempt at a token start), and `redactPathQuery` scans the token once,
    // so runs such as `=/=/=/...` stay linear.
    name: "path-query",
    pattern: /(?<![^\s"'])[^\s"']*\?[^\s"']*/g,
    replace: (token) => redactPathQuery(token),
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
    pattern: new RegExp(
      `(?<![A-Za-z0-9_.-])(--${SECRET_KEY})(\\s+|=)(?!-)${notRedacted}("[^"]*"|'[^']*'|\\S+)`,
      "gi",
    ),
    replace: (_match, key, separator) => `${key}${separator}${mark("key-value")}`,
  },
  {
    // `password=value`, `token: value`.
    name: "key-value",
    pattern: new RegExp(
      `(${SECRET_KEY_TAIL})(\\s*[=:]\\s*)${notRedacted}("[^"]*"|'[^']*'|[^\\s,;&"']+)`,
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
    text = text.replace(
      rule.pattern,
      rule.replace as (substring: string, ...args: string[]) => string,
    );
  }
  return text;
}

// Standard scheduler and kubelet Event shapes that name cluster objects: the node a Pod
// was assigned to, image references, and Secret and ConfigMap names. Each pattern starts
// at a fixed keyword and scans one bounded token, so matching stays linear.
const EVENT_RULES: readonly Rule[] = [
  {
    // `Successfully assigned <namespace>/<pod> to <node>`.
    name: "node",
    pattern: /\b(assigned\s+\S{1,512}\s+to\s+)[^\s,;:"']+/gi,
    replace: (_match, prefix) => `${prefix}${mark("node")}`,
  },
  {
    // `node "<name>"`, `nodes "<name>" not found`.
    name: "node",
    pattern: /\b(nodes?\s+)"[^"]*"/gi,
    replace: (_match, prefix) => `${prefix}"${mark("node")}"`,
  },
  {
    // `... on node <name>`.
    name: "node",
    pattern: /\b(on\s+node\s+)[^\s,;:"']+/gi,
    replace: (_match, prefix) => `${prefix}${mark("node")}`,
  },
  {
    // `Pulling image "<ref>"`, `failed to resolve reference "<ref>"`.
    name: "image",
    pattern: /\b(image|reference)(\s+)"[^"]*"/gi,
    replace: (_match, keyword, space) => `${keyword}${space}"${mark("image")}"`,
  },
  {
    name: "image",
    pattern: /\b(pull access denied for\s+)[^\s,;]+/gi,
    replace: (_match, prefix) => `${prefix}${mark("image")}`,
  },
  {
    // `secret "<name>" not found`, `configmap "<name>" not found`.
    name: "secret",
    pattern: /\b(secrets?|configmaps?)(\s+)"[^"]*"/gi,
    replace: (_match, keyword, space) => `${keyword}${space}"${mark("secret")}"`,
  },
  {
    // `couldn't find key <key> in Secret <namespace>/<name>`.
    name: "secret",
    pattern: /\b(Secret|ConfigMap)(\s+)[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9.-]{1,253}/g,
    replace: (_match, keyword, space) => `${keyword}${space}${mark("secret")}`,
  },
];

/**
 * Masks node names, image references and Secret and ConfigMap names in the standard
 * Kubernetes Event message shapes. Best-effort: other Event text can still name cluster
 * objects. Credential redaction still applies afterwards.
 */
export function maskRuntimeEventText(value: string): string {
  let text = value;
  for (const rule of EVENT_RULES) {
    text = text.replace(
      rule.pattern,
      rule.replace as (substring: string, ...args: string[]) => string,
    );
  }
  return text;
}

/** Removes ANSI escape sequences and C0/C1 control characters; tabs become spaces. */
export function stripRuntimeLogControls(value: string): string {
  let text = "";
  for (const character of stripVTControlCharacters(value)) {
    const code = character.codePointAt(0)!;
    if (code === 0x09) {
      text += " ";
    } else if (code >= 0x20 && (code < 0x7f || code > 0x9f)) {
      text += character;
    }
  }
  return text;
}
