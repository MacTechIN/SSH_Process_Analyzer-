import test from "node:test";
import { GenerationRepository } from "../../collector-api/src/repository/generation-repository.js";
import { FirestoreStore, createFirestore } from "../../collector-api/src/repository/firestore-store.js";
import { createContext, scenarios } from "../helpers/generation-scenarios.js";

const emulatorAvailable = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const firestore = emulatorAvailable
  ? createFirestore({ projectId: process.env.GCLOUD_PROJECT ?? "demo-ssh-analyzer" })
  : null;

for (const [index, scenario] of scenarios.entries()) {
  test(`firestore store: ${scenario.name}`, { skip: !emulatorAvailable }, async () => {
    const store = new FirestoreStore(firestore);
    await scenario.run(
      createContext({
        store,
        repository: new GenerationRepository(store),
        tenantId: `repo-tenant-${index}`
      })
    );
  });
}
