import type { CSSProperties } from "react";

type StatusPillProps = {
  status: "attested" | "attested_with_gaps" | "gap" | "sample";
};

const BASE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "18px",
  padding: "3px 9px",
  borderRadius: "3px",
  fontFamily: "var(--font-mono), monospace",
  fontSize: "10px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  lineHeight: 1,
  textTransform: "uppercase",
};

const GAP_STYLE: CSSProperties = {
  background: "var(--seal-wash)",
  border: "1px solid color-mix(in srgb, var(--yellow) 35%, transparent)",
  color: "var(--yellow)",
};

const STYLES: Record<StatusPillProps["status"], { label: string; style: CSSProperties }> = {
  attested: {
    label: "ATTESTED",
    style: {
      background: "var(--verified-wash)",
      border: "1px solid color-mix(in srgb, var(--green) 35%, transparent)",
      color: "var(--green)",
    },
  },
  attested_with_gaps: {
    label: "ATTESTED WITH GAPS",
    style: GAP_STYLE,
  },
  gap: {
    label: "GAP",
    style: GAP_STYLE,
  },
  sample: {
    label: "SAMPLE",
    style: {
      background: "transparent",
      border: "1px solid var(--yellow)",
      color: "var(--yellow)",
    },
  },
};

export function StatusPill({ status }: StatusPillProps) {
  const entry = STYLES[status];

  return <span style={{ ...BASE_STYLE, ...entry.style }}>{entry.label}</span>;
}
