import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalize } from "@/lib/canonical";
import {
  buildVerifyScript,
  getPacketBuildPaths,
  writePacketArtifacts,
} from "@/lib/packet-build";
import { PACKET_PUBLIC_ID, PACKET_PUBLIC_URL } from "@/lib/packet-public";
import { createArtifact, createPacketData } from "@/test/factories";

describe("packet build", () => {
  it("builds canonical packet artifacts and writes the hash module", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agentmint-build-"));
    const packet = createPacketData();

    const result = await writePacketArtifacts(packet, rootDir);
    const paths = getPacketBuildPaths(rootDir);

    expect(result.paths).toEqual(paths);
    expect(result.hash).toHaveLength(64);
    expect(paths.outputDir.endsWith(`/public/p/${PACKET_PUBLIC_ID}`)).toBe(true);
    expect(await readFile(paths.packetJsonPath, "utf8")).toBe(canonicalize(packet));
    expect(await readFile(paths.verifyScriptPath, "utf8")).toContain(`EXPECTED="${result.hash}"`);
    expect(await readFile(paths.packetHashModulePath, "utf8")).toBe(
      `export const PACKET_HASH = "${result.hash}";\n`,
    );
    expect((await stat(paths.verifyScriptPath)).mode & 0o777).toBe(0o755);
  });

  it("renders the verify script with default and custom urls", () => {
    expect(buildVerifyScript("abc123")).toContain(`URL="${PACKET_PUBLIC_URL}"`);
    expect(buildVerifyScript("abc123", "https://example.com/packet.json")).toContain(
      'URL="https://example.com/packet.json"',
    );
  });

  it("fails before writing files when invariants are invalid", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agentmint-invalid-"));
    const packet = createPacketData({
      artifacts: [
        createArtifact({
          id: "01",
          sections: [
            {
              label: "Core",
              fields: [
                {
                  machine_key: "broken",
                  display_label: "Broken",
                  value: true,
                  citation_ref: null,
                  is_attested: true,
                },
              ],
            },
          ],
        }),
      ],
    });

    await expect(writePacketArtifacts(packet, rootDir)).rejects.toThrow(
      "Invariant failed: artifact 01 field broken has citation_ref=null but is_attested=true.",
    );
  });
});
