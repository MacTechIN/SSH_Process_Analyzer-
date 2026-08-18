import test from "node:test";
import { GenerationRepository } from "../../collector-api/src/repository/generation-repository.js";
import { InMemoryStore } from "../../collector-api/src/repository/in-memory-store.js";
import { createContext, scenarios } from "../helpers/generation-scenarios.js";

for (const [index, scenario] of scenarios.entries()) {
  test(`in-memory store: ${scenario.name}`, async () => {
    const store = new InMemoryStore();
    await scenario.run(
      createContext({
        store,
        repository: new GenerationRepository(store),
        tenantId: `tenant-${index}`
      })
    );
  });
}
