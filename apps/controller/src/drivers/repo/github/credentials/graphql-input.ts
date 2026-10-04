// GitHub mints a clone credential for Repository.tempCloneToken. GraphQL field
// names are plain ASCII names with no escape syntax, so an alias or fragment still
// spells the field. JSON escapes could hide it in the request body; decode every
// string literal (duplicate keys included) before searching.
const providerCredentialField = "tempCloneToken";
const jsonString = /"(?:[^"\\]|\\.)*"/g;
// The `mutation` operation keyword is a GraphQL Name, so it cannot be escaped or
// split; refusing it wherever it appears as a whole Name also over-denies a field
// or string argument with that exact spelling, which is acceptable.
const mutationKeyword = /(?:^|[^_0-9A-Za-z])mutation(?:[^_0-9A-Za-z]|$)/;

function decodedLiterals(body: Uint8Array): string[] | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    JSON.parse(text);
  } catch {
    return;
  }
  // In valid JSON every quote outside a string starts a string literal.
  return [...text.matchAll(jsonString)].map(([literal]) => JSON.parse(literal) as string);
}

/** Refuse GraphQL request bodies that could select a provider clone credential. */
export function allowsGraphqlInput(body: Uint8Array): boolean {
  const literals = decodedLiterals(body);
  return literals !== undefined && !literals.some((text) => text.includes(providerCredentialField));
}

/**
 * Also refuse every mutation. A static token cannot be narrowed per session, and
 * mutations such as createRef or updateRef would write refs outside the push
 * allowlist the gateway enforces on receive-pack.
 */
export function allowsReadOnlyGraphqlInput(body: Uint8Array): boolean {
  const literals = decodedLiterals(body);
  return (
    literals !== undefined &&
    !literals.some((text) => text.includes(providerCredentialField) || mutationKeyword.test(text))
  );
}
