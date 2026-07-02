/**
 * @kernel
 * Minimal ZIP writer — node:zlib only, zero dependencies.
 *
 * Writes standard PKZIP archives (deflate, CRC-32, central directory, EOCD)
 * good enough for every mainstream extractor (unzip, Python zipfile, macOS
 * Finder, Windows Explorer). Unix file modes are carried in the central
 * directory's external attributes so a bundled verify script stays
 * executable after extraction.
 *
 * Kernel rule: imports node:zlib only. Never imports from experimental/ or
 * from .vendor/.
 */
import { deflateRawSync } from "node:zlib";

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** "version made by": 3 (Unix) << 8 | 20 (2.0) — carries external attrs. */
const VERSION_MADE_BY = (3 << 8) | 20;
const VERSION_NEEDED = 20;
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;

// CRC-32 (IEEE 802.3), table-driven.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInit {
  /** Forward-slash path inside the archive. */
  name: string;
  content: string | Uint8Array;
  /** Unix permission bits, e.g. 0o755 for an executable script. Default 0o644. */
  mode?: number;
  /** Entry mtime. Defaults to a fixed epoch for byte-stable archives. */
  date?: Date;
}

/** Fixed default timestamp → re-exporting the same content is byte-stable. */
const DEFAULT_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** Build a complete ZIP archive from entries, in memory. */
export function buildZip(entries: readonly ZipEntryInit[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const raw = typeof entry.content === "string" ? Buffer.from(entry.content, "utf-8") : Buffer.from(entry.content);
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store when deflate does not help (already-compressed or tiny content).
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const { time, date } = dosDateTime(entry.date ?? DEFAULT_DATE);
    const mode = entry.mode ?? 0o644;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); // Unix regular file + mode
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}
