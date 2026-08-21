import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

const FORBIDDEN_NAMES = [/^\.env/, /\.map$/, /service-account.*\.json$/i, /\.pem$/];
const FORBIDDEN_CONTENT = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key" },
  { pattern: /"type"\s*:\s*"service_account"/, label: "service account json" },
  { pattern: /AGENT_PRIVATE_KEY|CURSOR_SIGNING_SECRET|GOOGLE_APPLICATION_CREDENTIALS/, label: "server secret name" },
  { pattern: /sourceMappingURL=/, label: "source map reference" }
];

async function walk(directory) {
  const entries = await readdir(directory);
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    if ((await stat(path)).isDirectory()) {
      files.push(...(await walk(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

const files = await walk(DIST);
const findings = [];

for (const path of files) {
  const name = path.split("/").at(-1);
  for (const pattern of FORBIDDEN_NAMES) {
    if (pattern.test(name)) {
      findings.push(`${path}: file name matches ${pattern}`);
    }
  }
  if (!/\.(js|css|html|json|txt)$/.test(name)) {
    continue;
  }
  const content = await readFile(path, "utf8");
  for (const rule of FORBIDDEN_CONTENT) {
    if (rule.pattern.test(content)) {
      findings.push(`${path}: contains ${rule.label}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`hosting artifact is not deployable:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`hosting artifact scan passed for ${files.length} files\n`);
}
