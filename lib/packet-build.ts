import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalizeToBuffer, computeHash } from "./canonical";
import { assertPacketInvariants } from "./packet-invariants";
import { PACKET_PUBLIC_ID, PACKET_PUBLIC_URL } from "./packet-public";
import type { PacketData } from "./types";

export type PacketBuildPaths = {
  outputDir: string;
  packetJsonPath: string;
  verifyScriptPath: string;
  packetHashModulePath: string;
};

export function getPacketBuildPaths(rootDir = process.cwd()): PacketBuildPaths {
  const outputDir = resolve(rootDir, "public/p", PACKET_PUBLIC_ID);

  return {
    outputDir,
    packetJsonPath: resolve(outputDir, "packet.json"),
    verifyScriptPath: resolve(outputDir, "verify.sh"),
    packetHashModulePath: resolve(rootDir, "lib/packet-hash.ts"),
  };
}

export function buildVerifyScript(hash: string, url = PACKET_PUBLIC_URL): string {
  return `#!/usr/bin/env bash
set -euo pipefail
EXPECTED="${hash}"
URL="${url}"
ACTUAL=$(curl -s "$URL" | sha256sum | cut -d' ' -f1)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "OK  packet matches attested hash $EXPECTED";
else echo "FAIL  expected $EXPECTED"; echo "      got      $ACTUAL"; exit 1; fi
`;
}

function createPacketHashModuleSource(hash: string) {
  return `export const PACKET_HASH = "${hash}";\n`;
}

async function ensureDirForFile(filePath: string) {
  await mkdir(dirname(filePath), { recursive: true });
}

async function writePacketHashModule(filePath: string, hash: string) {
  await ensureDirForFile(filePath);
  await writeFile(filePath, createPacketHashModuleSource(hash), "utf8");
}

export async function writePacketArtifacts(packet: PacketData, rootDir = process.cwd()) {
  assertPacketInvariants(packet);

  const paths = getPacketBuildPaths(rootDir);
  const canonicalPacket = canonicalizeToBuffer(packet);
  const hash = computeHash(packet);

  await mkdir(paths.outputDir, { recursive: true });
  await writeFile(paths.packetJsonPath, canonicalPacket);
  await writeFile(paths.verifyScriptPath, buildVerifyScript(hash), "utf8");
  await chmod(paths.verifyScriptPath, 0o755);
  await writePacketHashModule(paths.packetHashModulePath, hash);

  return {
    hash,
    paths,
  };
}
