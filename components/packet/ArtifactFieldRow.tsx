import { StatusPill } from "@/components/ui/StatusPill";
import { CitationChip } from "@/components/packet/CitationChip";
import type { ArtifactField } from "@/lib/types";

type ArtifactFieldRowProps = {
  field: ArtifactField;
};

function isMonoField(field: ArtifactField) {
  return /hash|date|version|id|packet|timestamp|generated/i.test(field.machine_key);
}

export function ArtifactFieldRow({ field }: ArtifactFieldRowProps) {
  const mono = isMonoField(field);

  return (
    <div className="artifact-row">
      <div className="packet-field artifact-row__label">{field.display_label}</div>
      <div className="artifact-row__value-wrap">
        <div
          className={[
            "packet-value",
            "artifact-row__value",
            mono ? "artifact-row__value--mono" : "",
            !field.is_attested ? "artifact-row__value--gap" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {String(field.value)}
        </div>
        <div className="artifact-row__meta">
          {!field.is_attested ? <StatusPill status="gap" /> : null}
          {field.citation_ref ? <CitationChip citation_ref={field.citation_ref} /> : null}
        </div>
      </div>
    </div>
  );
}
