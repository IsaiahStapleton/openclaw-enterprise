export function createProviderResponseBody() {
  const chunks: Buffer[] = [];
  let length = 0;

  return {
    append(chunk: Buffer): boolean {
      length += chunk.length;
      if (length > 262144) {
        chunk.fill(0);
        return false;
      }
      chunks.push(chunk);
      return true;
    },
    assemble(): Buffer {
      return Buffer.concat(chunks);
    },
    discard(): void {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    },
  };
}
