// Length-prefixed JSON frames over a stream socket: [u32 BE length][utf-8 JSON].
import type { Socket } from "node:net";

const MAX_FRAME = 8 << 20;

export function writeFrame(sock: Socket, msg: unknown): boolean {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  // One write per frame: cork so header and body leave in a single syscall.
  sock.cork();
  sock.write(head);
  const ok = sock.write(body);
  sock.uncork();
  return ok;
}

/** Feed socket data; calls onFrame for every complete frame (pipelined). */
export function frameReader(onFrame: (msg: unknown) => void): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME) throw new Error(`frame of ${len} bytes exceeds limit`);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      onFrame(JSON.parse(body.toString("utf8")));
    }
  };
}
