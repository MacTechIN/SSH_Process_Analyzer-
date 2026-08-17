import { createConfig } from "./config.js";
import { InMemoryReplayStore } from "./in-memory-replay-store.js";
import { GenerationRepository } from "./repository/generation-repository.js";
import { InMemoryStore } from "./repository/in-memory-store.js";
import { createApiServer } from "./server.js";
import { SnapshotService } from "./snapshot-service.js";

export function createApp(env = process.env) {
  const config = createConfig(env);
  const store = new InMemoryStore();
  const service = new SnapshotService({
    store,
    repository: new GenerationRepository(store),
    replayStore: new InMemoryReplayStore(),
    config
  });
  return { config, store, service, server: createApiServer({ service, config, logger: log }) };
}

function log(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.server.listen(app.config.port, () => {
    log({ event: "listening", port: app.config.port, devReadApiEnabled: app.config.devReadApiEnabled });
  });
}
