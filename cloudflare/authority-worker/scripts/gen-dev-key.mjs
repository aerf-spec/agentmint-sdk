// Generate a local-dev log signing key into .dev.vars (gitignored) and print the public key.
// Usage: node scripts/gen-dev-key.mjs [--force]
import { generateKeyPairSync, createHash } from "node:crypto";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";

const path = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars");
let seedHex;
if (existsSync(path) && !process.argv.includes("--force")) {
  seedHex = /AUTHORITY_PRIVATE_KEY="?([0-9a-f]{64})/.exec(readFileSync(path, "utf8"))?.[1];
}
if (!seedHex) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  seedHex = der.subarray(der.length - 32).toString("hex");
  writeFileSync(path, `AUTHORITY_PRIVATE_KEY="${seedHex}"\n`, { mode: 0o600 });
  console.error(`wrote ${path}`);
}
const priv = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]),
  format: "der",
  type: "pkcs8",
});
const pub = createPublicKey(priv);
const spki = pub.export({ type: "spki", format: "der" });
const keyId = createHash("sha256").update(spki.subarray(spki.length - 32)).digest("hex").slice(0, 16);
process.stdout.write(pub.export({ type: "spki", format: "pem" }));
console.error(`log key_id: ${keyId}`);
