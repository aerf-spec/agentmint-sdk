import { describe, expect, it } from "vitest";

import claraHealthPacket from "@/lib/packet-data";
import { PACKET_HASH } from "@/lib/packet-hash";

describe("packet data exports", () => {
  it("exports the complete sample packet and a generated hash", () => {
    expect(claraHealthPacket.metadata.packet_id).toBe("sample-health-001");
    expect(claraHealthPacket.artifacts.map((artifact) => artifact.id)).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
      "07",
      "06",
      "11",
      "08",
      "09",
      "10",
      "12",
    ]);
    expect(claraHealthPacket.gap_register).toHaveLength(7);
    expect(claraHealthPacket.chai_crosswalk.length).toBeGreaterThan(0);
    expect(PACKET_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
});
