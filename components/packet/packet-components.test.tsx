import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactCard } from "@/components/packet/ArtifactCard";
import { ArtifactFieldRow } from "@/components/packet/ArtifactFieldRow";
import { AttestationBlock } from "@/components/packet/AttestationBlock";
import { ChaiCrosswalkBlock } from "@/components/packet/ChaiCrosswalkBlock";
import { CitationChip } from "@/components/packet/CitationChip";
import { ExecutiveSummaryBlock } from "@/components/packet/ExecutiveSummaryBlock";
import { GapRegisterTable } from "@/components/packet/GapRegisterTable";
import { GapSectionCard } from "@/components/packet/GapSectionCard";
import { OwaspTable } from "@/components/packet/OwaspTable";
import { PacketAccordion } from "@/components/packet/PacketAccordion";
import { PacketCover } from "@/components/packet/PacketCover";
import { VerificationActions } from "@/components/packet/VerificationActions";
import { VerificationSection } from "@/components/packet/VerificationSection";
import { createArtifact, createGap, createPacketData } from "@/test/factories";

describe("packet components", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders packet cover, executive summary, gap register, owasp table, and attestation", () => {
    const gap = createGap("G-01");
    const packet = createPacketData({
      gap_register: [gap],
      executive_summary: {
        system_description: "System summary.",
        status_line: "Status line.",
        top_gaps: ["G-01 — Missing control"],
        deal_context: "Deal context.",
        contact: "owner@example.com",
      },
      owasp_llm_assessment: [
        {
          threat_id: "LLM01",
          threat: "Prompt injection",
          control: "Isolation",
          status: "Controlled",
        },
        {
          threat_id: "LLM02",
          threat: "Data leakage",
          control: "Filters",
          status: "Needs work",
        },
      ],
      attestation: {
        statement: "Attested statement.",
        explicit_non_claims: ["No legal advice."],
        signed_date: "2026-06-09",
      },
    });

    render(
      <>
        <PacketCover data={packet} hash="abc123" />
        <ExecutiveSummaryBlock summary={packet.executive_summary} />
        <GapRegisterTable gaps={packet.gap_register} />
        <OwaspTable entries={packet.owasp_llm_assessment} />
        <AttestationBlock
          attestation={packet.attestation}
          metadata={packet.metadata}
          hash="1234567890abcdef"
        />
      </>,
    );

    expect(screen.getByText(packet.metadata.packet_id)).toBeInTheDocument();
    expect(screen.getByText("Status line.")).toBeInTheDocument();
    expect(screen.getByText("⚠ G-01 — Missing control")).toBeInTheDocument();
    expect(screen.getByText("STRUCTURED FOR CONDITIONAL-APPROVAL USE", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Prompt injection")).toBeInTheDocument();
    expect(screen.getAllByText("ATTESTED").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ATTESTED WITH GAPS").length).toBeGreaterThan(0);
    expect(screen.getByText("This attestation does not claim:")).toBeInTheDocument();
    expect(screen.getByText(/over packet SHA-256 12345678/i)).toBeInTheDocument();
  });

  it("falls back to the generated timestamp when the attestation date is blank", () => {
    const packet = createPacketData({
      metadata: {
        ...createPacketData().metadata,
        generated_at: "2026-06-10T14:12:00Z",
      },
      attestation: {
        ...createPacketData().attestation,
        signed_date: "",
      },
    });

    render(<PacketCover data={packet} hash="abc123" />);

    expect(screen.getByText(/signed 2026-06-10t14:12:00z/i)).toBeInTheDocument();
  });

  it("renders field rows, citation chips, gap cards, and detachable artifact cards", () => {
    const gap = createGap("G-02");
    const artifact = createArtifact({
      id: "04",
      title: "Forwardable Artifact",
      detachable: true,
      status: "attested_with_gaps",
      sections: [
        {
          label: "Core",
          fields: [
            {
              machine_key: "build_version",
              display_label: "Build Version",
              value: "2.1.0",
              citation_ref: "doc:model-card.pdf",
              is_attested: true,
            },
            {
              machine_key: "owner_gap",
              display_label: "Owner",
              value: "Unassigned",
              citation_ref: null,
              is_attested: false,
            },
          ],
        },
      ],
      gaps: [gap],
      ciso_simulation: [
        { question: "Question A", answer: "Answer A" },
        { question: "Question B", answer: "Answer B" },
      ],
    });
    const packet = createPacketData({ artifacts: [artifact] });

    render(
      <>
        <CitationChip citation_ref="doc:model-card.pdf" />
        <ArtifactFieldRow field={artifact.sections[0].fields[0]} />
        <ArtifactFieldRow field={artifact.sections[0].fields[1]} />
        <GapSectionCard gap={gap} />
        <ArtifactCard artifact={artifact} metadata={packet.metadata} />
      </>,
    );

    expect(screen.getAllByText("doc:model-card.pdf").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2.1.0")[0]).toHaveClass("artifact-row__value--mono");
    expect(screen.getAllByText("Unassigned")[0]).toHaveClass("artifact-row__value--gap");
    expect(screen.getAllByText("GAP").length).toBeGreaterThan(0);
    expect(screen.getAllByText("⚠ G-02 — Gap G-02").length).toBeGreaterThan(0);
    expect(screen.getByText("Detachable header - self-contained for forwarding.")).toBeInTheDocument();
    expect(screen.getByText("§04 — Forwardable Artifact (Detachable)")).toBeInTheDocument();
  });

  it("toggles accordion entries and returns null when empty", () => {
    const { rerender } = render(<PacketAccordion entries={[]} />);

    expect(screen.queryByRole("button", { name: /How\?/i })).not.toBeInTheDocument();

    rerender(
      <PacketAccordion
        entries={[
          { question: "How?", answer: "With evidence." },
          { question: "Why?", answer: "Because." },
        ]}
      />,
    );

    const firstToggle = screen.getByRole("button", { name: /How\?/i });
    fireEvent.click(firstToggle);
    expect(screen.getByText("With evidence.")).toHaveAttribute("data-visible", "true");
    expect(within(firstToggle).getByText("Hide")).toBeInTheDocument();

    fireEvent.click(firstToggle);
    expect(screen.getByText("With evidence.")).toHaveAttribute("data-visible", "false");
  });

  it("renders verification actions and triggers print", () => {
    const printSpy = vi.fn();
    window.print = printSpy;

    render(
      <VerificationActions
        packetUrl="/p/sample-health-001/packet.json"
        verifyScriptUrl="/p/sample-health-001/verify.sh"
      />,
    );

    expect(screen.getByRole("link", { name: /Download verify\.sh/i })).toHaveAttribute(
      "href",
      "/p/sample-health-001/verify.sh",
    );
    expect(screen.getByRole("link", { name: /Download packet\.json/i })).toHaveAttribute(
      "href",
      "/p/sample-health-001/packet.json",
    );

    fireEvent.click(screen.getByRole("button", { name: /Download PDF/i }));
    expect(printSpy).toHaveBeenCalled();
  });

  it("renders the verification section end to end", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    window.print = vi.fn();

    render(<VerificationSection hash="1234567890abcdef1234567890abcdef" />);

    expect(screen.getByText("What this proves")).toBeInTheDocument();
    expect(screen.getByText(/byte-identical to the packet Maya Chen attested/i)).toBeInTheDocument();
    expect(screen.getAllByText(/sha256sum packet\.json/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Copy Hash/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download verify\.sh/i })).toBeInTheDocument();
  });

  it("renders a CHAI crosswalk table", () => {
    render(
      <ChaiCrosswalkBlock
        entries={[
          {
            chai_field: "Model inventory",
            packet_location: "Artifact 02 -> Model Inventory",
          },
        ]}
      />,
    );

    expect(screen.getByText("CHAI CROSSWALK")).toBeInTheDocument();
    expect(screen.getByText("Model inventory")).toBeInTheDocument();
    expect(screen.getByText("Artifact 02 -> Model Inventory")).toBeInTheDocument();
  });
});
