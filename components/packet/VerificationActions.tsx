"use client";

type VerificationActionsProps = {
  packetUrl: string;
  verifyScriptUrl: string;
};

export function VerificationActions({ packetUrl, verifyScriptUrl }: VerificationActionsProps) {
  return (
    <div className="packet-actions no-print">
      <a className="cta-secondary" href={verifyScriptUrl} download>
        Download verify.sh
      </a>
      <a className="cta-secondary" href={packetUrl} download>
        Download packet.json
      </a>
      <button type="button" className="cta-primary" onClick={() => window.print()}>
        Download PDF
      </button>
    </div>
  );
}
