import test from "node:test";

test(
  "delivered service keeps provider credentials outside a separate Agent container",
  { timeout: 180000 },
  async (t) => {
    const serviceImage = process.env.REPOSITORY_CREDENTIALS_SERVICE_IMAGE;
    const clientImage = process.env.REPOSITORY_CREDENTIALS_CLIENT_IMAGE;
    if (!serviceImage && !clientImage) {
      t.skip(
        "requires delivered REPOSITORY_CREDENTIALS_SERVICE_IMAGE and REPOSITORY_CREDENTIALS_CLIENT_IMAGE",
      );
      return;
    }
    if (!serviceImage || !clientImage) {
      throw new Error("both delivered isolation images are required");
    }
    const { qualifyIsolation } =
      await import("../fixtures/repository-credentials-isolation/harness.mjs");
    await qualifyIsolation(t, { serviceImage, clientImage });
  },
);
