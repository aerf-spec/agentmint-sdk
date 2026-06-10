type CitationChipProps = {
  citation_ref: string;
};

export function CitationChip({ citation_ref }: CitationChipProps) {
  return <span className="citation-chip">{citation_ref}</span>;
}
