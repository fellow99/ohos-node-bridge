// tests/lib/tar-fixtures.mjs —— 程序化构造 tar / tar.gz 夹具（**不依赖宿主 tar**）。
//
// 为什么手写 512 字节头：契约 §4 要求测试覆盖 `prefix[155]`、GNU `L`、pax `x`、截断、路径穿越等
// 边界；宿主 `tar` 的版本/默认格式（gnu/pax/posix）不可控，且设备侧没有 tar。故这里直接按
// ustar（POSIX 1003.1-1988 + GNU L/pax x 扩展）字节布局拼块，任何机器上结果逐字节一致。
//
// 头布局（512 B，偏移见 POSIX）：
//   0 name[100] · 100 mode[8] · 108 uid[8] · 116 gid[8] · 124 size[12] · 136 mtime[12] ·
//   148 chksum[8] · 156 typeflag[1] · 157 linkname[100] · 257 magic[6]="ustar\0" · 263 version[2]="00" ·
//   265 uname[32] · 297 gname[32] · 329 devmajor[8] · 337 devminor[8] · 345 prefix[155] · 500 pad[12]

import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

export const BLOCK = 512;

/** 八进制字段：width-1 位数字 + NUL 终止（ustar 惯例）。 */
function writeOctal(buf, offset, width, value) {
  const digits = Number(value).toString(8).padStart(width - 1, '0').slice(-(width - 1));
  buf.write(digits, offset, width - 1, 'latin1');
  buf[offset + width - 1] = 0;
}

/** 内容补齐到 512 字节块。 */
export function pad512(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const rem = buf.length % BLOCK;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(BLOCK - rem, 0)]);
}

/** 构造一个 ustar 头块。name/prefix 超长时按字段宽度截断（这正是 `L`/prefix 用例要暴露的行为）。 */
export function header({
  name,
  typeflag = '0',
  size = 0,
  prefix = '',
  linkname = '',
  mode = 0o644,
  mtime = 1700000000,
  magic = true,
} = {}) {
  const b = Buffer.alloc(BLOCK, 0);
  b.write(String(name).slice(0, 100), 0, 100, 'utf8');
  writeOctal(b, 100, 8, mode);
  writeOctal(b, 108, 8, 0);
  writeOctal(b, 116, 8, 0);
  writeOctal(b, 124, 12, size);
  writeOctal(b, 136, 12, mtime);
  b.fill(0x20, 148, 156); // 校验和字段先按空格参与计算
  b.write(String(typeflag).slice(0, 1), 156, 1, 'latin1');
  b.write(String(linkname).slice(0, 100), 157, 100, 'utf8');
  if (magic) {
    b.write('ustar', 257, 5, 'latin1');
    b[262] = 0;
    b.write('00', 263, 2, 'latin1');
    b.write('nb', 265, 32, 'latin1');
    b.write('nb', 297, 32, 'latin1');
  }
  writeOctal(b, 329, 8, 0);
  writeOctal(b, 337, 8, 0);
  b.write(String(prefix).slice(0, 155), 345, 155, 'utf8');
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, '0').slice(-6), 148, 6, 'latin1');
  b[154] = 0; // 6 位数字 + NUL + 空格
  b[155] = 0x20;
  return b;
}

/** 普通文件条目（typeflag '0' + 数据 + 补齐）。 */
export function file(name, content, extra = {}) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  return [header({ name, typeflag: '0', size: data.length, ...extra }), pad512(data)];
}

/** 目录条目（typeflag '5'）。 */
export function dir(name) {
  const nm = String(name).endsWith('/') ? String(name) : String(name) + '/';
  return [header({ name: nm, typeflag: '5', size: 0 })];
}

/** 归档结束：两个全零块。 */
export function zeroBlocks() {
  return [Buffer.alloc(BLOCK * 2, 0)];
}

/** GNU `L`（长文件名）：先一条 `././@LongLink` 承载真名，再一条被截断名字的真条目。 */
export function gnuLongName(longName, content) {
  const link = Buffer.from(String(longName) + '\0', 'latin1');
  const data = Buffer.from(String(content), 'utf8');
  return [
    header({ name: '././@LongLink', typeflag: 'L', size: link.length }),
    pad512(link),
    header({ name: String(longName).slice(0, 100), typeflag: '0', size: data.length }),
    pad512(data),
  ];
}

function paxRecords(records) {
  let body = '';
  for (const [k, v] of Object.entries(records)) {
    const kv = ` ${k}=${v}\n`;
    let len = kv.length + 1;
    // 记录长度包含自身的十进制位数 ⇒ 不动点迭代
    while (String(len).length + kv.length !== len) len = String(len).length + kv.length;
    body += String(len) + kv;
  }
  return Buffer.from(body, 'utf8');
}

/** pax 扩展头（typeflag 'x'）：其**数据必须被跳过**，不能让后续条目错位。 */
export function paxHeader(records, name = 'PaxHeaders/entry') {
  const data = paxRecords(records);
  return [header({ name, typeflag: 'x', size: data.length }), pad512(data)];
}

/** pax 全局头（typeflag 'g'）：同样必须跳过数据。 */
export function paxGlobalHeader(records) {
  const data = paxRecords(records);
  return [header({ name: 'PaxHeaders/global', typeflag: 'g', size: data.length }), pad512(data)];
}

/** 把若干块拼成一个 tar 缓冲区。 */
export function tar(chunks) {
  return Buffer.concat(chunks.flat());
}

/** 写一个 gzip 压缩的 tar 到 path，返回未压缩的 tar 缓冲区。 */
export function writeTarGz(outPath, chunks) {
  const buf = tar(chunks);
  writeFileSync(outPath, gzipSync(buf));
  return buf;
}

/** 写一个「原样字节」的 tar.gz（用于截断 / 无结束块等非法夹具）。 */
export function writeRawTarGz(outPath, rawBuf) {
  writeFileSync(outPath, gzipSync(rawBuf));
  return rawBuf;
}
