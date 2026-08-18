import { createConfig } from "./config.js";
import { FirestoreReplayStore } from "./firestore-replay-store.js";
import { InMemoryReplayStore } from "./in-memory-replay-store.js";
import { GenerationRepository } from "./repository/generation-repository.js";
import { FirestoreStore, createFirestore } from "./repository/firestore-store.js";
import { InMemoryStore } from "./repository/in-memory-store.js";
import { createApiServer } from "./server.js";
import { SnapshotService } from "./snapshot-service.js";

export function createStores(config) {
  if (config.storageDriver === "firestore") {
    if (!config.projectId) {
      throw new Error("GOOGLE_CLOUD_PROJECT is required when STORAGE_DRIVER=firestore");
    }
    const firestore = createFirestore({ projectId: config.projectId, databaseId: config.databaseId });
    return { store: new FirestoreStore(firestore), replayStore: new FirestoreReplayStore(firestore) };
  }
  if (config.storageDriver !== "memory") {
    throw new Error(`unknown STORAGE_DRIVER ${config.storageDriver}`);
  }
  return { store: new InMemoryStore(), replayStore: new InMemoryReplayStore() };
}

export function createApp(env = process.env) {
  const config = createConfig(env);
  const { store, replayStore } = createStores(config);
  const service = new SnapshotService({
    store,
    repository: new GenerationRepository(store),
    replayStore,
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
    log({
      event: "listening",
      port: app.config.port,
      storageDriver: app.config.storageDriver,
      devReadApiEnabled: app.config.devReadApiEnabled
    });
  });
}
