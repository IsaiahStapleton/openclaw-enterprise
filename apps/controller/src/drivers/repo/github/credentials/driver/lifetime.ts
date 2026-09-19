// GitHub installation tokens expire one hour after issuance. Response receipt
// starts a conservative cleanup bound even when the local wall clock changes.
export const tokenLifetimeMs = 3600000;
export const providerClockSkewMs = 60000;
