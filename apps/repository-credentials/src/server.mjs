import { main } from "../dist/main.js";

await main().catch(() => {
  process.stderr.write("repository credential service failed\n");
  process.exitCode = 1;
});
