import { createConfig } from "../src/config.js";
import { runCleanup } from "../src/cleanup-job.js";
import { createStores } from "../src/index.js";
import { GenerationRepository } from "../src/repository/generation-repository.js";

const config = createConfig();
const { store } = createStores(config);

const summary = await runCleanup({
  store,
  repository: new GenerationRepository(store),
  config,
  log: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`)
});

process.exitCode = summary.failed > 0 ? 1 : 0;
