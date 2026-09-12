export function createDevelopmentIAMState(seed) {
  const servicePrincipals = "servicePrincipal" in seed ? [seed.servicePrincipal] : [];
  return Object.freeze({
    identities: Object.freeze([seed.principal, ...servicePrincipals]),
    groups: Object.freeze([]),
    memberships: Object.freeze([]),
    roles: Object.freeze([...seed.roles]),
    bindings: Object.freeze([...seed.bindings]),
    restrictions: Object.freeze([]),
  });
}
