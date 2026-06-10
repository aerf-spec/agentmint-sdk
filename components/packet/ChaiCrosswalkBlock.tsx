import { MonoLabel } from "@/components/ui/MonoLabel";
import type { ChaiCrosswalkEntry } from "@/lib/types";

type ChaiCrosswalkBlockProps = {
  entries: ChaiCrosswalkEntry[];
};

export function ChaiCrosswalkBlock({ entries }: ChaiCrosswalkBlockProps) {
  return (
    <section className="packet-section">
      <MonoLabel>CHAI CROSSWALK</MonoLabel>
      <div className="crosswalk-table">
        <p className="crosswalk-table__caption">
          Buyer questionnaire bridge - maps common CHAI-style prompts to the exact packet section
          that answers them.
        </p>
        <div className="crosswalk-table__scroll">
          <table>
            <thead>
              <tr>
                <th>CHAI field</th>
                <th>Packet location</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={`${entry.chai_field}-${entry.packet_location}`}>
                  <td>{entry.chai_field}</td>
                  <td>{entry.packet_location}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
