import type { Attestation, PacketMetadata } from "@/lib/types";

type AttestationBlockProps = {
  attestation: Attestation;
  metadata: PacketMetadata;
  hash: string;
};

export function AttestationBlock({ attestation, metadata, hash }: AttestationBlockProps) {
  return (
    <section className="attestation-block">
      <p className="attestation-block__label">ATTESTATION</p>
      <p className="attestation-block__statement">{attestation.statement}</p>
      <div>
        <p className="attestation-block__subhead">This attestation does not claim:</p>
        <ul className="attestation-block__list">
          {attestation.explicit_non_claims.map((claim) => (
            <li key={claim}>{claim}</li>
          ))}
        </ul>
      </div>
      <p className="attestation-block__signature">{`${metadata.attested_by_name} · ${metadata.attested_by_title} · ${attestation.signed_date} · over packet SHA-256 ${hash.slice(0, 8)}…`}</p>
    </section>
  );
}
