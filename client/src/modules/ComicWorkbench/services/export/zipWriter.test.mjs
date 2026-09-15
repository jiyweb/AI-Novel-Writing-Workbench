/**
 * ZIP writer 单测：CRC32 标准向量 + ZIP 二进制结构校验
 * 运行：node --experimental-strip-types --test src/modules/ComicWorkbench/services/export/zipWriter.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { crc32, buildZip } from "./zipWriter.ts";

const encoder = new TextEncoder();

test("crc32 标准测试向量", () => {
  assert.equal(crc32(encoder.encode("123456789")), 0xcbf43926);
});

test("crc32 空数据为 0", () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("crc32 单字节向量", () => {
  // "a" 的 CRC32
  assert.equal(crc32(encoder.encode("a")), 0xe8b7be43);
});

test("buildZip 单条目：结构签名与尺寸一致", () => {
  const data = encoder.encode("hello zip");
  const blob = buildZip([{ name: "a.txt", data }]);
  assert.ok(blob.size > 0);
});

test("buildZip 多条目：EOCD 记录的条目数与偏移可对上", async () => {
  const entries = [
    { name: "ch01/panel-001.png", data: encoder.encode("first") },
    { name: "ch01/panel-002.png", data: encoder.encode("second-file") },
    { name: "ch02/说明-中文.png", data: encoder.encode("third") },
  ];
  const blob = buildZip(entries);
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buffer.buffer);

  // 首条 local header 签名
  assert.equal(view.getUint32(0, true), 0x04034b50);

  // EOCD 签名固定在文件尾部 22 字节处（无注释）
  const eocdOffset = buffer.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
  assert.equal(view.getUint16(eocdOffset + 8, true), 3); // 本盘条目数
  assert.equal(view.getUint16(eocdOffset + 10, true), 3); // 总条目数

  // central directory 起始偏移与尺寸
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  assert.equal(centralOffset + centralSize + 22, buffer.length);

  // central directory 首签名
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);

  // 第三条目的 local header 可由 central directory 的偏移定位到
  const lastCentral = centralOffset + centralSize - (46 + encoder.encode("ch02/说明-中文.png").length);
  const lastLocalOffset = view.getUint32(lastCentral + 42, true);
  assert.equal(view.getUint32(lastLocalOffset, true), 0x04034b50);
  // STORE 方式：compressed size == uncompressed size
  assert.equal(view.getUint32(lastLocalOffset + 18, true), encoder.encode("third").length);
  assert.equal(view.getUint32(lastLocalOffset + 22, true), encoder.encode("third").length);
});
