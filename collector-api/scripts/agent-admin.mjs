import { AgentRegistry } from "../src/agent-registry.js";
import { createConfig } from "../src/config.js";
import { createStores } from "../src/index.js";

const USAGE = `usage: node collector-api/scripts/agent-admin.mjs <command> [options]

commands:
  register     --tenant <id> --host <id> --agent <id> --kid <id> --public-key <base64url> --actor <who>
  rotate-key   --agent <id> --kid <id> --public-key <base64url> --actor <who>
  revoke-key   --agent <id> --kid <id> --actor <who>
  quarantine   --agent <id> --reason <text> --actor <who>
  release      --agent <id> --reason <text> --actor <who>
  describe     --agent <id>

the public key is the raw 32 ed25519 bytes in base64url:
  openssl pkey -in agent-key.pem -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d '='
`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument ${flag}`);
    }
    options[flag.slice(2)] = argv[index + 1];
  }
  return options;
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "--help" || command === "help") {
  process.stdout.write(USAGE);
  process.exit(command ? 0 : 1);
}

const options = parseArgs(rest);
const config = createConfig();
const { store } = createStores(config);
const registry = new AgentRegistry({ store });

const commands = {
  register: () =>
    registry.register({
      tenantId: options.tenant,
      hostId: options.host,
      agentId: options.agent,
      kid: options.kid,
      publicKey: options["public-key"],
      actor: options.actor
    }),
  "rotate-key": () =>
    registry.rotateKey({
      agentId: options.agent,
      kid: options.kid,
      publicKey: options["public-key"],
      actor: options.actor
    }),
  "revoke-key": () => registry.revokeKey({ agentId: options.agent, kid: options.kid, actor: options.actor }),
  quarantine: () =>
    registry.quarantine({ agentId: options.agent, reason: options.reason, actor: options.actor }),
  release: () =>
    registry.releaseQuarantine({ agentId: options.agent, reason: options.reason, actor: options.actor }),
  describe: () => registry.describe(options.agent)
};

if (!commands[command]) {
  process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
  process.exit(1);
}

try {
  await commands[command]();
  const described = await registry.describe(options.agent);
  process.stdout.write(`${JSON.stringify(described, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code ?? "FAILED", message: error.message })}\n`);
  process.exitCode = 1;
}
