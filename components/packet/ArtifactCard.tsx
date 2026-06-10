import { PacketAccordion } from "@/components/packet/PacketAccordion";
import { ArtifactFieldRow } from "@/components/packet/ArtifactFieldRow";
import { DetachableHeader } from "@/components/packet/DetachableHeader";
import { GapSectionCard } from "@/components/packet/GapSectionCard";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { StatusPill } from "@/components/ui/StatusPill";
import type { Artifact, PacketMetadata } from "@/lib/types";

type ArtifactCardProps = {
  artifact: Artifact;
  metadata: PacketMetadata;
};

export function ArtifactCard({ artifact, metadata }: ArtifactCardProps) {
  return (
    <article className="packet-card artifact-card">
      <header className="artifact-card__header">
        <p className="artifact-card__title">
          {`§${artifact.id} — ${artifact.title}${artifact.detachable ? " (Detachable)" : ""}`}
        </p>
        <StatusPill status={artifact.status} />
      </header>

      {artifact.detachable ? <DetachableHeader metadata={metadata} /> : null}

      {artifact.sections.map((section) => (
        <section key={`${artifact.id}-${section.label}`} className="artifact-card__section">
          <MonoLabel>{section.label}</MonoLabel>
          <div className="artifact-card__rows">
            {section.fields.map((field) => (
              <ArtifactFieldRow key={`${artifact.id}-${section.label}-${field.machine_key}`} field={field} />
            ))}
          </div>
        </section>
      ))}

      {artifact.gaps.length > 0 ? (
        <div className="artifact-card__gaps">
          {artifact.gaps.map((gap) => (
            <GapSectionCard key={gap.id} gap={gap} />
          ))}
        </div>
      ) : null}

      <section className="artifact-card__section">
        <MonoLabel>CISO Simulation</MonoLabel>
        <PacketAccordion entries={artifact.ciso_simulation} />
      </section>
    </article>
  );
}
