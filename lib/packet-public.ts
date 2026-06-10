export const PACKET_PUBLIC_ID = "sample-health-001";
export const PACKET_JSON_PATH = `/p/${PACKET_PUBLIC_ID}/packet.json`;
export const PACKET_VERIFY_SCRIPT_PATH = `/p/${PACKET_PUBLIC_ID}/verify.sh`;
export const PACKET_PUBLIC_URL = `https://agentmint.run${PACKET_JSON_PATH}`;
export const PACKET_VERIFY_COMMAND = `curl -sO ${PACKET_PUBLIC_URL} && sha256sum packet.json`;

export function formatPacketHashPreview(hash: string) {
  return `${hash.slice(0, 8)}…`;
}
