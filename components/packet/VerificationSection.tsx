import { HashDisplay } from "@/components/ui/HashDisplay";
import { VerificationActions } from "@/components/packet/VerificationActions";
import {
  PACKET_JSON_PATH,
  PACKET_VERIFY_COMMAND,
  PACKET_VERIFY_SCRIPT_PATH,
} from "@/lib/packet-public";

type VerificationSectionProps = {
  hash: string;
};

export function VerificationSection({ hash }: VerificationSectionProps) {
  return (
    <section id="verification" className="verification-section">
      <div className="verification-section__grid">
        <div>
          <h2 className="verification-section__heading">What this proves</h2>
          <p className="verification-section__copy">
            byte-identical to the packet Maya Chen attested — nothing altered after signing
          </p>
        </div>
        <div>
          <h2 className="verification-section__heading">What it does not prove</h2>
          <p className="verification-section__copy">
            the truth of the claims — those rest on cited evidence, the attestation, and marked
            gaps
          </p>
        </div>
      </div>
      <pre className="packet-code-block">
        <code>{PACKET_VERIFY_COMMAND}</code>
      </pre>
      <HashDisplay hash={hash} />
      <VerificationActions packetUrl={PACKET_JSON_PATH} verifyScriptUrl={PACKET_VERIFY_SCRIPT_PATH} />
    </section>
  );
}
