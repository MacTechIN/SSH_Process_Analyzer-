import { createConfig } from "../src/config.js";
import { createStores } from "../src/index.js";

const USAGE = `usage: node collector-api/scripts/grant-membership.mjs --tenant <id> --uid <firebase uid> [--role viewer|operator|admin] [--name <tenant name>]

Firebase Auth uid는 사용자가 웹앱에 한 번 로그인한 뒤 Firebase 콘솔의 Authentication 화면에서 확인한다.
`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`unexpected argument ${flag}`);
    }
    options[flag.slice(2)] = argv[index + 1];
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.tenant || !options.uid) {
  process.stderr.write(USAGE);
  process.exit(1);
}

const role = options.role ?? "viewer";
if (!["viewer", "operator", "admin"].includes(role)) {
  process.stderr.write(`role must be viewer, operator, or admin\n`);
  process.exit(1);
}

const { store } = createStores(createConfig());
await store.seedTenant({ tenantId: options.tenant, name: options.name ?? options.tenant });
await store.seedMembership({ tenantId: options.tenant, uid: options.uid, role });

process.stdout.write(
  `${JSON.stringify({ tenantId: options.tenant, uid: options.uid, role }, null, 2)}\n`
);
