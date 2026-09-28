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
