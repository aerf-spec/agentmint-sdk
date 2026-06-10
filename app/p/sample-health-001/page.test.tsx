import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import claraHealthPacket from "@/lib/packet-data";

vi.mock("@/lib/packet-hash", () => ({
  PACKET_HASH: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
}));

describe("sample packet page", () => {
  it("renders packet metadata, verification controls, and the sample banner", async () => {
    const module = await import("@/app/p/sample-health-001/page");
    const SamplePacketPage = module.default;

    const { container } = render(<SamplePacketPage />);

    expect(module.dynamic).toBe("force-static");
    expect(module.metadata.title).toBe(
      "ClaraHealth prior-auth-v2.1 — AI Vendor Evidence Packet (sample)",
    );
    expect(screen.getByText(/SAMPLE — ClaraHealth is fictional/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Verify$/i })).toHaveAttribute("href", "#verification");
    expect(screen.getAllByText(/SHA-256 12345678…/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Executive Summary")).toBeInTheDocument();
    expect(screen.getByText("Gap Register")).toBeInTheDocument();
    expect(screen.getByText("OWASP LLM TOP-10 ASSESSMENT (V2.0)")).toBeInTheDocument();
    expect(screen.getByText("CHAI CROSSWALK")).toBeInTheDocument();
    expect(screen.getByText("ATTESTATION")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download PDF/i })).toBeInTheDocument();

    const artifactTitles = Array.from(container.querySelectorAll(".artifact-card__title")).map((node) =>
      node.textContent?.trim(),
    );
    expect(artifactTitles).toEqual(
      claraHealthPacket.artifacts.map(
        (artifact) => `§${artifact.id} — ${artifact.title}${artifact.detachable ? " (Detachable)" : ""}`,
      ),
    );
    expect(container.querySelectorAll(".gap-table__row")).toHaveLength(7);

    const packetExit = container.querySelector(".packet-exit");
    const footer = container.querySelector(".packet-footer");
    expect(packetExit).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(packetExit?.compareDocumentPosition(footer as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
