import type { GapEntry } from "@/lib/types";

type GapSectionCardProps = {
  gap: GapEntry;
};

export function GapSectionCard({ gap }: GapSectionCardProps) {
  return (
    <article className="gap-card">
      <p className="gap-card__title">{`⚠ ${gap.id} — ${gap.title}`}</p>
      <p className="gap-card__description">{gap.description}</p>
      <p className="gap-card__remediation">{gap.remediation}</p>
      <p className="gap-card__owner">{`OWNER ${gap.owner_name}, ${gap.owner_title} · TARGET ${gap.target_date}`}</p>
      <p className="gap-card__control">{`COMPENSATING CONTROL — ${gap.compensating_control}`}</p>
    </article>
  );
}
