import { MonoLabel } from "@/components/ui/MonoLabel";
import { SerifBody } from "@/components/ui/SerifBody";
import { StatusPill } from "@/components/ui/StatusPill";
import { PACKET_VERIFY_COMMAND } from "@/lib/packet-public";
import type { ExecutiveSummary } from "@/lib/types";

type ExecutiveSummaryBlockProps = {
  summary: ExecutiveSummary;
};

export function ExecutiveSummaryBlock({ summary }: ExecutiveSummaryBlockProps) {
  return (
    <section className="packet-section">
      <MonoLabel>Executive Summary</MonoLabel>
      <div className="packet-section__stack">
        <SerifBody>{summary.system_description}</SerifBody>
        <div className="packet-summary__status">
          <p className="packet-summary__line">{summary.status_line}</p>
          <StatusPill status="attested_with_gaps" />
        </div>
        <div className="packet-summary__gaps">
          {summary.top_gaps.map((gap) => (
            <p key={gap} className="packet-summary__gap">{`⚠ ${gap}`}</p>
          ))}
        </div>
        <p className="packet-summary__context">{summary.deal_context}</p>
        <pre className="packet-code-block">
          <code>{PACKET_VERIFY_COMMAND}</code>
        </pre>
        <p className="packet-summary__contact">{summary.contact}</p>
      </div>
    </section>
  );
}
