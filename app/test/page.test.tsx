import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { resolveSampleHash } from "@/lib/test-page";

describe("/test page", () => {
  it("renders the page with the generated packet hash", async () => {
    vi.resetModules();
    vi.doMock("@/lib/packet-hash", () => ({
      PACKET_HASH: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    }));

    const module = await import("@/app/test/page");
    render(<module.default />);

    expect(screen.getByText("Healthcare Packet System")).toBeInTheDocument();
    expect(screen.getByText("UI primitives on the production dark canvas.")).toBeInTheDocument();
    expect(screen.getByText("1234567890ab...abcdef")).toBeInTheDocument();
  });

  it("falls back to the hard-coded sample hash when PACKET_HASH is empty", async () => {
    expect(resolveSampleHash("")).toBe(
      "5f4dcc3b5aa765d61d8327deb882cf992b6ce3f06f4bdbd7868f95d7f8db8814",
    );
    const module = await import("@/app/test/page");
    render(<module.default />);
    expect(screen.getAllByText("Serif narrative with mono metadata.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SAMPLE").length).toBeGreaterThan(0);
  });
});
