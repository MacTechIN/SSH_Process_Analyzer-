import { createConfig, requireRuntimeConfig } from "./config.js";
import { runOnce } from "./run-once.js";

function log(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export async function main(env = process.env) {
  const config = requireRuntimeConfig(createConfig(env));
  return runOnce({ config, log });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await main();
    process.exitCode = result.skipped || result.pushed || result.spooled ? 0 : 1;
  } catch (error) {
    log({ event: "failed", error: error.message });
    process.exitCode = 1;
  }
}
