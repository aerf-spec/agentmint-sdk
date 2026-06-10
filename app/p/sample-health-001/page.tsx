import type { Metadata } from "next";

import { ArtifactCard } from "@/components/packet/ArtifactCard";
import { AttestationBlock } from "@/components/packet/AttestationBlock";
import { ChaiCrosswalkBlock } from "@/components/packet/ChaiCrosswalkBlock";
import { ExecutiveSummaryBlock } from "@/components/packet/ExecutiveSummaryBlock";
import { GapRegisterTable } from "@/components/packet/GapRegisterTable";
import { OwaspTable } from "@/components/packet/OwaspTable";
import { PacketCover } from "@/components/packet/PacketCover";
import { VerificationSection } from "@/components/packet/VerificationSection";
import { HashDisplay } from "@/components/ui/HashDisplay";
import { MonoLabel } from "@/components/ui/MonoLabel";
import { siteCopy } from "@/content/site-copy";
import { PACKET_HASH } from "@/lib/packet-hash";
import claraHealthPacket from "@/lib/packet-data";
import { formatPacketHashPreview } from "@/lib/packet-public";

export const dynamic = "force-static";
const copy = siteCopy.packet;

export const metadata: Metadata = {
  title: copy.metadata.title,
  description: copy.metadata.description,
};

export default function SamplePacketPage() {
  const hashPreview = formatPacketHashPreview(PACKET_HASH);

  return (
    <div className="filing">
      <nav className="packet-nav no-print">
        <div className="packet-nav__inner">
          <p className="packet-nav__identity">{`${claraHealthPacket.metadata.packet_id} · SHA-256 ${hashPreview}`}</p>
          <a href="#verification" className="packet-nav__link">
            {copy.nav.verifyLabel}
          </a>
        </div>
      </nav>

      <div className="sample-banner no-print">{copy.sampleBanner}</div>

      <main className="container packet-page">
        <div className="packet-page__content">
          <PacketCover data={claraHealthPacket} hash={PACKET_HASH} />
          <ExecutiveSummaryBlock summary={claraHealthPacket.executive_summary} />
          <GapRegisterTable gaps={claraHealthPacket.gap_register} />

          <section className="packet-section">
            <MonoLabel>{copy.artifactsLabel}</MonoLabel>
            <div className="packet-artifacts">
              {claraHealthPacket.artifacts.map((artifact) => (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  metadata={claraHealthPacket.metadata}
                />
              ))}
            </div>
          </section>

          <OwaspTable entries={claraHealthPacket.owasp_llm_assessment} />
          <ChaiCrosswalkBlock entries={claraHealthPacket.chai_crosswalk} />
          <AttestationBlock
            attestation={claraHealthPacket.attestation}
            metadata={claraHealthPacket.metadata}
            hash={PACKET_HASH}
          />
          <VerificationSection hash={PACKET_HASH} />
        </div>
      </main>

      <section className="packet-exit no-print">
        <div className="packet-exit__inner">
          <p className="packet-cta__copy">{copy.exit.copy}</p>
          <a href="/" className="cta-primary">
            {copy.exit.cta}
          </a>
        </div>
      </section>

      <footer className="packet-footer">
        <div className="packet-footer__inner">
          <p className="packet-footer__colophon">
            {`${claraHealthPacket.metadata.packet_id} · SHA-256 ${hashPreview} · ${claraHealthPacket.metadata.generated_at}`}
          </p>
          <a href="https://github.com/aerf-spec/aerf" className="packet-footer__link">
            {copy.footer.standardLabel}
          </a>
          <HashDisplay hash={PACKET_HASH} short />
        </div>
      </footer>
    </div>
  );
}
