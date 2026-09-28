/** Explicit classification for controller-approved workload templates. Label
 * writers and NetworkPolicy enforcement remain separate trust boundaries.
 *
 * This module is the single home for network profile constants. The ordinary
 * profile is the only value today; a provider-fenced profile for Harness Pods
 * owned by a SandboxDriver is planned as a second value in a follow-up. */
export const NETWORK_PROFILE_LABEL = "openclaw.dev/network-profile";
export const ORDINARY_NETWORK_PROFILE = "broad-egress-v1";

/** Ordinary grants require their exact profile. Scope labels cannot override it. */
export function ordinaryNetworkPolicySelector(matchLabels: Readonly<Record<string, string>> = {}): {
  matchLabels: Record<string, string>;
} {
  return {
    matchLabels: { ...matchLabels, [NETWORK_PROFILE_LABEL]: ORDINARY_NETWORK_PROFILE },
  };
}

/** The same selector without the profile, as written before explicit profiles.
 * Only for keeping a serving pre-profile workload's grant until it is replaced. */
export function withoutNetworkProfile(selector: Readonly<Record<string, unknown>> | undefined): {
  matchLabels: Record<string, string>;
} {
  const labels = selector?.matchLabels;
  const matchLabels: Record<string, string> = {};
  if (typeof labels === "object" && labels !== null) {
    for (const [name, value] of Object.entries(labels)) {
      if (name !== NETWORK_PROFILE_LABEL && typeof value === "string") {
        matchLabels[name] = value;
      }
    }
  }
  return { matchLabels };
}
