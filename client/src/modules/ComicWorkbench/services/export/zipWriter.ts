/**
 * 手写 ZIP writer（STORE 存储，无压缩）+ CRC32
 *
 * 导出的 PNG 本身已是压缩格式，再用 deflate 收益极小，
 * 因此 ZIP 采用 STORE 方式：结构简单、可在纯浏览器环境零依赖完成。
 * 文件名按 UTF-8（general purpose flag 0x0800）写入，支持中文。
 */

/** CRC32 查表（多项式 0xEDB88320） */
const CRC_TABLE: number[] = (() => {
  const table: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 计算 CRC32（无符号 32 位） */
export function crc32(data: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

export interface ZipEntry {
  /** ZIP 内路径（可用 / 分层，UTF-8） */
  name: string;
  /** ArrayBuffer 后端（BlobPart 要求）；new Uint8Array(await blob.arrayBuffer()) 即满足 */
  data: Uint8Array<ArrayBuffer>;
}

/** 生成 ZIP 文件 Blob（STORE 方式） */
export function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array<ArrayBuffer>[] = [];
  const centralChunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    // Local file header（30 字节定长 + 文件名）
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags：UTF-8 文件名
    lv.setUint16(8, 0, true); // method：STORE
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0x21, true); // mod date：1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true); // compressed size
    lv.setUint32(22, entry.data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    localChunks.push(local, entry.data);

    // Central directory entry（46 字节定长 + 文件名）
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); // method
    cv.setUint16(12, 0, true); // time
    cv.setUint16(14, 0x21, true); // date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length + entry.data.length;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);

  // End of central directory（22 字节）
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // central dir disk
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central dir offset
  ev.setUint16(20, 0, true); // comment length

  return new Blob([...localChunks, ...centralChunks, eocd], { type: "application/zip" });
}
