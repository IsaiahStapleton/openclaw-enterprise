import { main } from "../dist/repository-credentials.js";
await main().catch(() => {
  process.stderr.write("repository credential service failed\n");
  process.exitCode = 1;
});
