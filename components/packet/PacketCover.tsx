import { HashDisplay } from "@/components/ui/HashDisplay";
import { SignedStamp } from "@/components/ui/SignedStamp";
import { StatusPill } from "@/components/ui/StatusPill";
import type { PacketData } from "@/lib/types";

type PacketCoverProps = {
  data: PacketData;
  hash: string;
};

export function PacketCover({ data, hash }: PacketCoverProps) {
  const artifactCount = data.artifacts.length;
  const gapCount = data.gap_register.length;

  return (
    <section className="packet-card packet-cover">
      <div className="packet-cover__top">
        <div className="packet-cover__identity">
          <p className="packet-cover__packet-id">{data.metadata.packet_id}</p>
          <StatusPill status="sample" />
        </div>
        <SignedStamp date={data.attestation.signed_date || data.metadata.generated_at} />
      </div>

      <div className="packet-cover__grid">
        <div>
          <span className="packet-cover__label">Vendor</span>
          <p className="packet-cover__value">{data.metadata.vendor}</p>
        </div>
        <div>
          <span className="packet-cover__label">System</span>
          <p className="packet-cover__value">{data.metadata.system}</p>
        </div>
        <div>
          <span className="packet-cover__label">Workflow</span>
          <p className="packet-cover__value">{data.metadata.workflow}</p>
        </div>
        <div>
          <span className="packet-cover__label">Classification</span>
          <p className="packet-cover__value">{data.metadata.regulatory_classification}</p>
        </div>
        <div>
          <span className="packet-cover__label">Generated</span>
          <p className="packet-cover__value">{data.metadata.generated_at}</p>
        </div>
        <div>
          <span className="packet-cover__label">Attested By</span>
          <p className="packet-cover__value">{`${data.metadata.attested_by_name} · ${data.metadata.attested_by_title}`}</p>
        </div>
        <div>
          <span className="packet-cover__label">Methodology</span>
          <p className="packet-cover__value">{data.metadata.methodology_version}</p>
        </div>
        <div>
          <span className="packet-cover__label">Artifacts</span>
          <p className="packet-cover__value">{`${artifactCount} of ${artifactCount} produced · ${gapCount} open gaps, all owned and dated`}</p>
        </div>
      </div>

      <HashDisplay hash={hash} short />
    </section>
  );
}
