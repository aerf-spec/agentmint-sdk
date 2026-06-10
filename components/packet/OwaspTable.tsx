import { MonoLabel } from "@/components/ui/MonoLabel";
import { StatusPill } from "@/components/ui/StatusPill";
import type { OWASPEntry } from "@/lib/types";

type OwaspTableProps = {
  entries: OWASPEntry[];
};

function statusVariant(status: string) {
  return status === "Controlled" ? "attested" : "attested_with_gaps";
}

export function OwaspTable({ entries }: OwaspTableProps) {
  return (
    <section className="packet-section">
      <MonoLabel>OWASP LLM TOP-10 ASSESSMENT (V2.0)</MonoLabel>
      <div className="owasp-table">
        <table>
          <thead>
            <tr>
              <th>Threat ID</th>
              <th>Threat</th>
              <th>Control</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.threat_id} className="owasp-table__row">
                <td>{entry.threat_id}</td>
                <td>{entry.threat}</td>
                <td>{entry.control}</td>
                <td>
                  <StatusPill status={statusVariant(entry.status)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="owasp-table__footnote">Version footnote: OWASP LLM Top 10 v2.0 mapping.</p>
      </div>
    </section>
  );
}
