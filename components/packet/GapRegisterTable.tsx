import { MonoLabel } from "@/components/ui/MonoLabel";
import type { GapEntry } from "@/lib/types";

type GapRegisterTableProps = {
  gaps: GapEntry[];
};

export function GapRegisterTable({ gaps }: GapRegisterTableProps) {
  return (
    <section className="packet-section">
      <MonoLabel>Gap Register</MonoLabel>
      <div className="gap-table">
        <p className="gap-table__caption">
          STRUCTURED FOR CONDITIONAL-APPROVAL USE — each entry is a corrective action with owner
          and due date.
        </p>
        <div className="gap-table__scroll">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Gap</th>
                <th>Owner</th>
                <th>Target</th>
                <th>Compensating</th>
                <th>Remediation</th>
              </tr>
            </thead>
            <tbody>
              {gaps.map((gap) => (
                <tr key={gap.id} className="gap-table__row">
                  <td>{gap.id}</td>
                  <td>{gap.title}</td>
                  <td>{`${gap.owner_name}, ${gap.owner_title}`}</td>
                  <td>{gap.target_date}</td>
                  <td>{gap.compensating_control}</td>
                  <td>{gap.remediation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
