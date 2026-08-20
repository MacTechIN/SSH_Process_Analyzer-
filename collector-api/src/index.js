import { createConfig } from "./config.js";
import { FirestoreReplayStore } from "./firestore-replay-store.js";
import { InMemoryReplayStore } from "./in-memory-replay-store.js";
import { GenerationRepository } from "./repository/generation-repository.js";
import { FirestoreStore, createFirebaseApp, createFirestore } from "./repository/firestore-store.js";
import { HistoryService } from "./history-service.js";
import { InMemoryStore } from "./repository/in-memory-store.js";
import { createApiServer } from "./server.js";
import { SnapshotService } from "./snapshot-service.js";

export function createStores(config) {
  if (config.storageDriver === "firestore") {
    if (!config.projectId) {
      throw new Error("GOOGLE_CLOUD_PROJECT is required when STORAGE_DRIVER=firestore");
    }
    const app = createFirebaseApp({ projectId: config.projectId });
    const firestore = createFirestore({ projectId: config.projectId, databaseId: config.databaseId, app });
    return {
      store: new FirestoreStore(firestore),
      replayStore: new FirestoreReplayStore(firestore),
      app
    };
  }
  if (config.storageDriver !== "memory") {
    throw new Error(`unknown STORAGE_DRIVER ${config.storageDriver}`);
  }
  return { store: new InMemoryStore(), replayStore: new InMemoryReplayStore() };
}

async function firebaseIdTokenVerifier(app) {
  const { getAuth } = await import("firebase-admin/auth");
  const auth = getAuth(app);
  return (idToken) => auth.verifyIdToken(idToken);
}

export function createApp(env = process.env, overrides = {}) {
  const config = createConfig(env);
  const { store, replayStore, app } = createStores(config);
  const service = new SnapshotService({
    store,
    repository: new GenerationRepository(store),
    replayStore,
    config
  });

  // No verifier means no way to authenticate a reader, so the history API stays closed.
  const verifyIdToken =
    overrides.verifyIdToken ??
    (app
      ? async (idToken) => (await firebaseIdTokenVerifier(app))(idToken)
      : () => {
          throw new Error("firebase auth is not configured for this storage driver");
        });
  const historyService = new HistoryService({ store, config, verifyIdToken });

  return {
    config,
    store,
    service,
    historyService,
    server: createApiServer({ service, historyService, config, logger: log })
  };
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
