#!/usr/bin/env node
// ohos-selfsign.mjs — HarmonyOS ELF "--selfSign 1" signing/verification, zero dependency.
//
// 用途：给准备投放进 HAP 的原生库（libnode.so / 引导件）做**自签名**，或校验签名有效性。
// 自签名不需要私钥、不需要证书：签名内容 = SHA-256(fs-verity descriptor)，
// descriptor 里只放文件 Merkle 树根（4K 页）等元信息。
//
// 格式（依据与算法出处，MIT）：
//   https://github.com/Bibapcs/ohos-node-jit-patch
//   （tools/selfsign.py + src/wxjit.c:merkle_root/self_sign_image —— 逆向自
//    `binary-sign-tool sign -selfSign 1`，并与该工具输出做过字节级比对）
// 本文件是该算法的 JS 移植 + verify 模式 + round-trip 自测。
//
// **已验证**：对上游真实已签产物 `prebuilt/wxjit.so`（35136 B）：
//   - `verify` 十项全过（含 Merkle 根与签名摘要逐字节匹配）；
//   - `selftest` 清零后重签 = **逐字节一致**。
//   - ⚠️ 该产物的 `PT_GNU_RELRO.p_align` 仍是 **1**（未被改）⇒ 上游「签名前把 p_align
//     改成 8」的说法**不普适**；故本实现默认**不改**，仅在显式 `--relro-align8` 时才改。
//
// 用法：
//   node tools/ohos-selfsign.mjs sign   <in.so> <out.so> [--relro-align8]
//   node tools/ohos-selfsign.mjs verify <file.so>
//   node tools/ohos-selfsign.mjs selftest <signed.so>      # 清零后重签，应与原文件逐字节一致
//
// 若产物没有 .codesign 段，先用 llvm-objcopy 补一个**页对齐**的全零段（4096 B）：
//   llvm-objcopy --add-section .codesign=<4096-zero.bin> \
//                --set-section-flags .codesign=alloc,load,readonly,data in.so out.so

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PAGE = 4096;
const CS_SIZE = 4096;
const PT_GNU_RELRO = 0x6474e552;

const ARGV = process.argv.slice(2);
const RELRO_ALIGN8 = ARGV.includes('--relro-align8');
const ARGS = ARGV.filter((a) => !a.startsWith('--'));

const sha256 = (buf) => createHash('sha256').update(buf).digest();
const readU16 = (b, o) => b.readUInt16LE(o);
const readU32 = (b, o) => b.readUInt32LE(o);
const readU64 = (b, o) => Number(b.readBigUInt64LE(o));

function checkElf64(buf) {
  if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error('not an ELF file');
  }
  if (buf[4] !== 2 || buf[5] !== 1) throw new Error('only 64-bit little-endian ELF is supported');
}

function sectionTable(buf) {
  const shoff = readU64(buf, 40);
  const shentsize = readU16(buf, 58);
  const shnum = readU16(buf, 60);
  const shstrndx = readU16(buf, 62);
  const shstrOff = readU64(buf, shoff + shstrndx * shentsize + 24);
  const nameOf = (idx) => {
    const nameOff = readU32(buf, shoff + idx * shentsize);
    const end = buf.indexOf(0, shstrOff + nameOff);
    return buf.toString('utf8', shstrOff + nameOff, end);
  };
  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const base = shoff + i * shentsize;
    sections.push({
      name: nameOf(i),
      shOffset: readU64(buf, base + 24),
      shSize: readU64(buf, base + 32),
    });
  }
  return sections;
}

function findSection(buf, name) {
  const s = sectionTable(buf).find((x) => x.name === name);
  if (!s) throw new Error(`no ${name} section (add one with llvm-objcopy first)`);
  return s;
}

/** 仅当显式 --relro-align8 时调用；默认不改（依据见文件头「已验证」段）。 */
function fixRelroAlign(buf) {
  const phoff = readU64(buf, 32);
  const phentsize = readU16(buf, 54);
  const phnum = readU16(buf, 56);
  for (let i = 0; i < phnum; i++) {
    const base = phoff + i * phentsize;
    if (readU32(buf, base) === PT_GNU_RELRO) buf.writeBigUInt64LE(8n, base + 48);
  }
}

/** fs-verity 风格 Merkle 根：4K 页叶哈希；`.codesign` 覆盖的页叶哈希置零；逐层 4K 打包再哈希。 */
function merkleRoot(buf, csOff, csLen) {
  const npages = Math.ceil(buf.length / PAGE);
  const p0 = Math.floor(csOff / PAGE);
  const p1 = Math.ceil((csOff + csLen) / PAGE);
  let cur = [];
  for (let i = 0; i < npages; i++) {
    if (i >= p0 && i < p1) { cur.push(Buffer.alloc(32)); continue; }
    const blk = Buffer.alloc(PAGE);
    buf.copy(blk, 0, i * PAGE, Math.min((i + 1) * PAGE, buf.length));
    cur.push(sha256(blk));
  }
  for (;;) {
    const packed = Buffer.concat(cur);
    if (packed.length <= PAGE) {
      const last = Buffer.alloc(PAGE);
      packed.copy(last, 0);
      return sha256(last);
    }
    const next = [];
    for (let i = 0; i < packed.length; i += PAGE) {
      const blk = Buffer.alloc(PAGE);
      packed.copy(blk, 0, i, Math.min(i + PAGE, packed.length));
      next.push(sha256(blk));
    }
    cur = next;
  }
}

function buildDescriptor(root, fileSize, signSize) {
  const d = Buffer.alloc(256);
  d[0] = 1;    // version
  d[1] = 1;    // hashAlgorithm = SHA-256
  d[2] = 12;   // log2BlockSize
  d[3] = 0;    // saltSize
  d.writeUInt32LE(signSize, 4);
  d.writeBigUInt64LE(BigInt(fileSize), 8);
  root.copy(d, 16);            // rootHash (32B @16)
  d.writeUInt32LE(0x10, 112);  // flags = FLAG_SELF_SIGN
  d.writeBigUInt64LE(0n, 120); // merkleTreeOffset = 0
  d[255] = 3;                  // csVersion
  return d;
}

/** head(8B: type=1, length=288) + descriptor(256B) + SHA256(descriptor with signSize=0)(32B) = 296B */
function buildSignature(buf, csOff) {
  const root = merkleRoot(buf, csOff, CS_SIZE);
  const sig = sha256(buildDescriptor(root, buf.length, 0));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(1, 0);
  head.writeUInt32LE(256 + 32, 4);
  const payload = Buffer.concat([head, buildDescriptor(root, buf.length, 32), sig]);
  if (payload.length !== 296) throw new Error('internal: signature payload must be 296 bytes');
  return payload;
}

function sign(inPath, outPath) {
  const buf = Buffer.from(readFileSync(inPath));
  checkElf64(buf);
  if (RELRO_ALIGN8) fixRelroAlign(buf);
  const cs = findSection(buf, '.codesign');
  if (cs.shSize !== CS_SIZE || cs.shOffset % PAGE !== 0) {
    throw new Error(`.codesign must be ${CS_SIZE}B at a page-aligned offset (got size=${cs.shSize} off=${cs.shOffset})`);
  }
  buildSignature(buf, cs.shOffset).copy(buf, cs.shOffset);
  writeFileSync(outPath, buf);
  return { csOff: cs.shOffset, size: buf.length };
}

function verify(path) {
  const buf = readFileSync(path);
  checkElf64(buf);
  const cs = findSection(buf, '.codesign');
  const head = { type: readU32(buf, cs.shOffset), length: readU32(buf, cs.shOffset + 4) };
  const d = buf.subarray(cs.shOffset + 8, cs.shOffset + 8 + 256);
  const got = {
    version: d[0], hashAlgorithm: d[1], log2BlockSize: d[2], signSize: readU32(d, 4),
    dataSize: readU64(d, 8), rootHash: d.subarray(16, 48).toString('hex'),
    flags: readU32(d, 112), csVersion: d[255],
  };
  const expectRoot = merkleRoot(buf, cs.shOffset, cs.shSize).toString('hex');
  const expectSig = sha256(Buffer.concat([d.subarray(0, 4), Buffer.alloc(4), d.subarray(8)])).toString('hex');
  const gotSig = buf.subarray(cs.shOffset + 8 + 256, cs.shOffset + 296).toString('hex');
  const checks = [
    ['head.type == 1', head.type === 1],
    ['head.length == 288', head.length === 288],
    ['descriptor.version == 1', got.version === 1],
    ['hashAlgorithm == 1 (SHA-256)', got.hashAlgorithm === 1],
    ['log2BlockSize == 12', got.log2BlockSize === 12],
    ['flags == 0x10 (FLAG_SELF_SIGN)', got.flags === 0x10],
    ['csVersion == 3', got.csVersion === 3],
    ['dataSize == file size', got.dataSize === buf.length],
    ['Merkle root matches content', got.rootHash === expectRoot],
    ['signature digest matches', gotSig === expectSig],
  ];
  return { head, descriptor: got, checks, pass: checks.every(([, ok]) => ok) };
}

function selftest(path) {
  const orig = readFileSync(path);
  const buf = Buffer.from(orig);
  const cs = findSection(buf, '.codesign');
  buf.fill(0, cs.shOffset, cs.shOffset + 296); // 清零签名负载
  if (RELRO_ALIGN8) fixRelroAlign(buf);
  buildSignature(buf, cs.shOffset).copy(buf, cs.shOffset);
  const same = Buffer.compare(buf, orig) === 0;
  let firstDiff = -1;
  if (!same) {
    for (let i = 0; i < buf.length; i++) if (buf[i] !== orig[i]) { firstDiff = i; break; }
  }
  return { same, firstDiff, size: orig.length };
}

/**
 * 给 ELF 追加一个「官方工具期望形态」的 .codesign 段：
 *   PROGBITS / 4096 B / **文件偏移页对齐(4096)** / 段对齐 4096 / 无任何属性标志。
 * 依据真实已签产物实测（`wxjit.so`：`[36] .codesign PROGBITS 0 007000 001000 00 … 4096`）。
 * 实现方式：把段数据与新段表都**追加**到文件尾部并改 `e_shoff`/`e_shnum`，
 * 原文件字节**一字不动**（Merkle 树覆盖全文件，追加字节自然纳入）。
 * ⚠️ `llvm-objcopy --add-section` 做不到页对齐（实测落成 Al=1、偏移非页对齐），故自实现。
 */
function addSection(inPath, outPath) {
  const buf = Buffer.from(readFileSync(inPath));
  checkElf64(buf);
  if (sectionTable(buf).some((s) => s.name === '.codesign')) throw new Error('already has .codesign');
  const shoff = readU64(buf, 40);
  const shentsize = readU16(buf, 58);
  const shnum = readU16(buf, 60);
  const shstrndx = readU16(buf, 62);
  const shstr = sectionTable(buf)[shstrndx];

  // 1) 新 shstrtab = 原内容 + ".codesign\0"，新段名索引 = 原长度
  const oldShstr = buf.subarray(shstr.shOffset, shstr.shOffset + shstr.shSize);
  const newName = Buffer.from('.codesign\0', 'utf8');
  const newShstr = Buffer.concat([oldShstr, newName]);
  const nameIdx = oldShstr.length;

  // 2) .codesign 数据放在「原 EOF 之后最近的页边界」
  const csOff = Math.ceil(buf.length / PAGE) * PAGE;
  // 3) 新 shstrtab 数据紧跟其后
  const shstrOff = csOff + CS_SIZE;
  // 4) 新段表放在最后（8 字节对齐即可）
  const shtOff = Math.ceil((shstrOff + newShstr.length) / 8) * 8;

  const out = Buffer.alloc(shtOff + (shnum + 1) * shentsize);
  buf.copy(out, 0);                                   // 原字节一字不动
  newShstr.copy(out, shstrOff);
  // 复制原段表条目（并把 shstrtab 条目指向新位置）
  for (let i = 0; i < shnum; i++) buf.copy(out, shtOff + i * shentsize, shoff + i * shentsize, shoff + (i + 1) * shentsize);
  const shstrEntry = shtOff + shstrndx * shentsize;
  out.writeBigUInt64LE(BigInt(shstrOff), shstrEntry + 24);
  out.writeBigUInt64LE(BigInt(newShstr.length), shstrEntry + 32);
  // 追加 .codesign 条目
  const e = shtOff + shnum * shentsize;
  out.writeUInt32LE(nameIdx, e);            // sh_name
  out.writeUInt32LE(1, e + 4);              // sh_type = PROGBITS
  out.writeBigUInt64LE(0n, e + 8);          // sh_flags = 0（不参与装载）
  out.writeBigUInt64LE(0n, e + 16);         // sh_addr
  out.writeBigUInt64LE(BigInt(csOff), e + 24);
  out.writeBigUInt64LE(BigInt(CS_SIZE), e + 32);
  out.writeUInt32LE(0, e + 40);             // sh_link
  out.writeUInt32LE(0, e + 44);             // sh_info
  out.writeBigUInt64LE(BigInt(PAGE), e + 48); // sh_addralign = 4096
  out.writeBigUInt64LE(0n, e + 56);         // sh_entsize
  // 更新 ELF 头
  out.writeBigUInt64LE(BigInt(shtOff), 40); // e_shoff
  out.writeUInt16LE(shnum + 1, 60);         // e_shnum
  writeFileSync(outPath, out);
  return { csOff, size: out.length };
}
const [cmd, a, b] = ARGS;
try {
  if (cmd === 'add-section') {
    const r = addSection(a, b);
    console.log(`add-section : ${b}  (.codesign @ ${r.csOff} (page-aligned), file ${r.size} B)`);
  } else if (cmd === 'sign') {
    const r = sign(a, b);
    console.log(`signed: ${b}  (.codesign @ ${r.csOff}, file ${r.size} B${RELRO_ALIGN8 ? ', relro-align8' : ''})`);
  } else if (cmd === 'verify') {
    const r = verify(a);
    console.log(`file        : ${a}`);
    console.log(`head        : type=${r.head.type} length=${r.head.length}`);
    console.log(`descriptor  : ${JSON.stringify(r.descriptor)}`);
    for (const [name, ok] of r.checks) console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}`);
    console.log(r.pass ? 'VERIFY: PASS' : 'VERIFY: FAIL');
    process.exitCode = r.pass ? 0 : 1;
  } else if (cmd === 'selftest') {
    const r = selftest(a);
    console.log(`selftest    : ${r.same
      ? 'IDENTICAL (re-sign reproduces the file byte-for-byte)'
      : `MISMATCH at byte ${r.firstDiff} of ${r.size}`}`);
    process.exitCode = r.same ? 0 : 1;
  } else {
    console.log('usage: ohos-selfsign.mjs add-section <in> <out> | sign <in> <out> [--relro-align8] | verify <file> | selftest <signed-file>');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 3;
}
