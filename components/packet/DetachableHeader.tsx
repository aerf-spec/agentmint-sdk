import type { PacketMetadata } from "@/lib/types";

type DetachableHeaderProps = {
  metadata: PacketMetadata;
};

export function DetachableHeader({ metadata }: DetachableHeaderProps) {
  return (
    <div className="artifact-card__detach">
      <p className="artifact-card__detach-note">Detachable header - self-contained for forwarding.</p>
      <div>VENDOR {metadata.vendor}</div>
      <div>SYSTEM {metadata.system}</div>
      <div>GENERATED {metadata.generated_at}</div>
      <div>PACKET ID {metadata.packet_id}</div>
    </div>
  );
}
