import type { GitHubProfile } from "./types.ts";

const profiles = Object.freeze({
  "git-read": Object.freeze({ metadata: "read", contents: "read" }),
  "git-write": Object.freeze({ metadata: "read", contents: "write" }),
  "git-full": Object.freeze({
    metadata: "read",
    contents: "write",
    pull_requests: "write",
    issues: "write",
  }),
});

export function permissionsForProfile(profile: GitHubProfile): Readonly<Record<string, string>> {
  if (typeof profile !== "string" || !Object.hasOwn(profiles, profile)) {
    throw new Error("unsupported-profile");
  }
  return profiles[profile];
}
