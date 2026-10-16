/*
 * tar-extract.js —— 真正流式的 ustar(.tar.gz) 解包器（契约 §3.7）
 *
 * 为什么独立成模块 + 为什么必须自己写：
 *   ① C3「让最终使用者去读」：ArkTS/鸿蒙侧解压器写出的文件 Node 读不到（MODULE_NOT_FOUND）
 *      ⇒ 载荷解包只能由 Node 自己做（zlib + fs），且不许整包缓冲（单卷 156.6 MB 压缩态 / 884 MB 展开态）。
 *   ② 参考实现（旧壳 src-main/tar-extract.js）的「header / data / padding」状态机已在真机验证，
 *      本文件移植其分块解析逻辑，但**新增**契约要求的三处：GNU 长名（L）、ustar prefix 拼接、
 *      base-256 长度字段，以及**路径穿越拒绝**（旧实现完全没有校验，`../` 会写到沙箱任意位置）。
 *
 * 依赖面：只允许 Node 内置（zlib / fs / path），零 npm（HAR 不带 node_modules，NFR-004-005）。
 * 内存面：header 最多缓冲 512 B（carry），数据随到随写，全程与条目大小无关（NFR-004-003）。
 *
 * 支持 typeflag：'0'/'\0'（文件）、'5'（目录）、'L'（GNU 长名，吃掉下一个块作为名字）、
 *              'x'/'g'（pax/global 扩展头，**跳过其数据**）；其余（链接/设备/FIFO）跳过并记日志。
 * 明确不做：symlink()/link()/mknod() —— 真机上 symlink 在应用域 EACCES，且链接是路径穿越的后门。
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const BLOCK = 512;
/** 文件 / 目录固定 mode：真机没有可用的 uid/gid 模型，mtime 也无人消费（契约 §3.7） */
const MODE_FILE = 0o644;
const MODE_DIR = 0o755;
/** GNU 长名最长接受 64 KB（真实场景 ≤ 4 KB；设上限是为了拒绝畸形头导致的无限缓冲） */
const LONG_NAME_LIMIT = 64 * 1024;

/**
 * 定长字段取字符串：只去掉**尾部** NUL 填充（UTF-8 解码）。
 * 刻意**不**在第一个 NUL 处截断：名字中间出现 NUL 是畸形/构造头（攻击面），
 * 交给 safePath 明确拒绝，而不是当成「名字到此为止」（C2：畸形输入不得被静默接受）。
 */
function fieldText(buf, start, end) {
  const slice = buf.subarray(start, end);
  let last = slice.length;
  while (last > 0 && slice[last - 1] === 0) last -= 1;
  return slice.subarray(0, last).toString('utf8');
}

/**
 * 解析 tar 数字字段。
 * - 空 / 全空白 ⇒ 0
 * - 首字节高位（0x80）置位 ⇒ **base-256**（二进制大端无符号），取低 7 位起算
 * - 其余 ⇒ 八进制文本；非八进制字符 **抛错**（C2：畸形字段不得被静默当 0）
 */
function parseSizeField(field) {
  if (field.length === 0) return 0;
  if ((field[0] & 0x80) !== 0) {
    let value = field[0] & 0x7f;
    for (let i = 1; i < field.length; i += 1) {
      value = value * 256 + field[i];
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error('tar: size field overflows JS integer');
    }
    return value;
  }
  const text = field.toString('latin1').replace(/\0/g, ' ').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error('tar: invalid size field: ' + JSON.stringify(text));
  }
  return parseInt(text, 8);
}

/**
 * 解析 512 字节 ustar 头（契约 §3.7；供单测直接调用）。
 * name = prefix[155] + '/' + name[100]（prefix 非空时），否则 name。
 * @returns {{name: string, size: number, typeflag: string}}
 */
function parseHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < BLOCK) {
    throw new Error('tar: header must be a 512-byte Buffer, got ' + (buf ? buf.length : String(buf)));
  }
  const rawName = fieldText(buf, 0, 100);
  const prefix = fieldText(buf, 345, 500);
  const name = prefix ? prefix + '/' + rawName : rawName;
  return {
    name,
    size: parseSizeField(buf.subarray(124, 136)),
    typeflag: String.fromCharCode(buf[156]),
  };
}

/** 目录条目名统一去掉尾部斜杠，便于 path.resolve 与计数 */
function trimDirName(name) {
  return name.replace(/\/+$/, '');
}

/** 512 字节对齐后的填充长度 */
function padSize(size) {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** 整块是否全 0（归档结束块判据；C4：只看首字节会把畸形头当结束，静默截断归档） */
function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/**
 * 纯流式 ustar 解析器（字节流进、回调出；不碰 fs，便于单测）。
 * handlers: { onDirectory(name), onFile(name, meta) -> {write(buf), end()}, onSkip(name, typeflag) }
 * @returns {{push: Function, finish: Function, stats: object}}
 */
function createUstarParser(handlers) {
  const h = handlers || {};
  const stats = { files: 0, dirs: 0, bytes: 0, skipped: 0 };

  let state = 'header'; // 'header' | 'data' | 'padding'
  let carry = Buffer.alloc(0); // 只会是「不足 512 的残片」，有界
  let entry = null; // { name, size, sink, longNameChunks, remaining, padding }
  let pendingLongName = null; // GNU 'L' 记录的名字，作用于紧随其后的条目
  let finished = false;

  function newEntry(name, size, sink, longNameChunks) {
    return { name, size, sink, longNameChunks, remaining: size, padding: padSize(size) };
  }

  function beginEntry(meta) {
    const name = pendingLongName !== null ? pendingLongName : meta.name;
    pendingLongName = null;

    if (meta.typeflag === 'L') {
      // GNU 长名：名字就是数据块本身，吃掉它，等下一个真条目使用
      if (meta.size > LONG_NAME_LIMIT) {
        throw new Error('tar: GNU long name too long: ' + meta.size);
      }
      entry = newEntry(name, meta.size, null, []);
      state = 'data';
      return;
    }
    if (meta.typeflag === 'x' || meta.typeflag === 'g') {
      // pax / global 扩展头：本实现不消费其记录，但**必须跳掉数据**，否则块对齐错位
      if (h.onSkip) h.onSkip(name, meta.typeflag);
      stats.skipped += 1;
      entry = newEntry(name, meta.size, null, null);
      state = 'data';
      return;
    }
    if (meta.typeflag === '5') {
      const dirName = trimDirName(name);
      // `.` / `./` 是「归档根本身」条目（GNU tar 打 `-C dir .` 时必现）：不建目录也不计数
      if (dirName && dirName !== '.') {
        if (h.onDirectory) h.onDirectory(dirName);
        stats.dirs += 1;
      }
      entry = newEntry(dirName, meta.size, null, null);
      state = 'data';
      return;
    }
    if (meta.typeflag === '0' || meta.typeflag === '\0' || meta.typeflag === '') {
      const sink = h.onFile ? h.onFile(name, meta) : null;
      stats.files += 1;
      entry = newEntry(name, meta.size, sink, null);
      state = 'data';
      return;
    }
    // '1' 硬链接 / '2' 符号链接 / '3'/'4' 设备 / '6' FIFO / '7' 连续文件 / 未知：跳过载荷并记日志
    if (h.onSkip) h.onSkip(name, meta.typeflag);
    stats.skipped += 1;
    entry = newEntry(name, meta.size, null, null);
    state = 'data';
  }

  function finishEntry() {
    // 只清 sink / 长名缓冲，**保留 entry**（padding 状态还要用它推进块对齐）
    if (entry.longNameChunks) {
      // 长名数据只去掉尾部 NUL 终止符：中间的 NUL 留给 safePath 拒绝（畸形头不静默接受）
      const text = Buffer.concat(entry.longNameChunks, entry.size).toString('utf8').replace(/\0+$/, '').trim();
      if (text) pendingLongName = text;
      entry.longNameChunks = null;
    } else if (entry.sink) {
      entry.sink.end();
      stats.bytes += entry.size;
      entry.sink = null;
    }
  }

  function push(chunk) {
    if (finished || !chunk || chunk.length === 0) return;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let pos = 0;

    while (pos < buf.length) {
      if (state === 'header') {
        if (buf.length - pos < BLOCK) break;
        const header = buf.subarray(pos, pos + BLOCK);
        pos += BLOCK;
        if (header[0] === 0) {
          /*
           * 归档结束块：必须是**整块 512 B 全 0**（tar 规范：两个全 0 块）。
           * C4：旧实现只看首字节 ⇒ 一个「首字节为 0、其余非 0」的畸形/截断头会被当成结束，
           * 其后的条目被**静默丢弃**，finish() 反而通过，bootstrap 还会为这棵**不完整**的树
           * 写就绪 marker（此后每次启动都信任它）。整块校验 + 明确抛错是唯一安全口径。
           */
          if (!isZeroBlock(header)) {
            throw new Error('tar: malformed end block (first byte 0 but block not all-zero) at offset ' + (pos - BLOCK));
          }
          finished = true;
          carry = Buffer.alloc(0);
          return;
        }
        beginEntry(parseHeader(header));
        continue;
      }

      if (state === 'data') {
        if (entry.remaining > 0) {
          const n = Math.min(entry.remaining, buf.length - pos);
          const slice = buf.subarray(pos, pos + n);
          if (entry.longNameChunks) entry.longNameChunks.push(Buffer.from(slice));
          else if (entry.sink) entry.sink.write(slice);
          pos += n;
          entry.remaining -= n;
        }
        if (entry.remaining === 0) {
          finishEntry();
          state = 'padding';
          continue;
        }
        break; // 条目数据未到齐，等下一个 chunk
      }

      // state === 'padding'
      const n = Math.min(entry.padding, buf.length - pos);
      pos += n;
      entry.padding -= n;
      if (entry.padding === 0) {
        entry = null;
        state = 'header';
      } else {
        break;
      }
    }

    carry = pos < buf.length ? Buffer.from(buf.subarray(pos)) : Buffer.alloc(0);
  }

  function finish() {
    if (finished) return;
    // 数据块被截断 ⇒ 硬失败（半成品文件绝不能被当成解包成功，C2）
    if (state === 'data' && entry && entry.remaining > 0) {
      throw new Error('tar: truncated entry data: ' + entry.name);
    }
    if (state === 'header' && carry.length > 0) {
      // 允许「最后一个条目之后直接 EOF」（缺终止块）；但残片必须全 0，否则是半个头
      if (!isZeroBlock(carry)) throw new Error('tar: truncated entry data (partial header block)');
    }
    // state === 'padding' 的残尾（缺尾部对齐填充）容忍：文件数据已完整写出
  }

  return { push, finish, stats };
}

/**
 * 流式解包 .tar.gz 到目标目录（契约 §3.7）。
 * @param {string} archivePath 归档路径（绝对路径优先）
 * @param {string} destDir 解包目标根
 * @param {{log?: (text: string) => void}} [opts] log 收到带 `[tar] ` 前缀的单行文本（可选）
 * @returns {Promise<{files: number, bytes: number, dirs: number, skipped: number}>}
 *          `skipped` = 被跳过的条目数（链接/设备/FIFO/未知 typeflag + pax 扩展头）——
 *          C4：调用方（bootstrap）必须把它写进就绪 marker，解包树不完整才可审计。
 */
function extractTarGz(archivePath, destDir, opts) {
  const options = opts || {};
  const onLog = typeof options.log === 'function' ? options.log : null;
  const dest = path.resolve(destDir);

  const tarLog = (text) => {
    if (onLog) onLog('[tar] ' + text);
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let openFd = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (openFd !== null) {
        try { fs.closeSync(openFd); } catch (_) { /* fd 已关或进程退出中，忽略 */ }
        openFd = null;
      }
      try { gunzip.destroy(); } catch (_) { /* 忽略 */ }
      try { input.destroy(); } catch (_) { /* 忽略 */ }
      reject(err);
    };

    /**
     * 路径安全校验（契约 §3.7 / FR-004-014）：解析后的绝对路径必须落在目标目录内。
     * 三条拒绝：NUL 字节、绝对路径条目、`..` 穿越。
     */
    const safePath = (name) => {
      if (name.indexOf('\0') !== -1) {
        throw new Error('tar: entry name contains NUL: ' + JSON.stringify(name));
      }
      if (name.length === 0) {
        throw new Error('tar: empty entry name');
      }
      if (path.isAbsolute(name)) {
        throw new Error('tar: path escapes destination: ' + name);
      }
      const abs = path.resolve(dest, name);
      const rel = path.relative(dest, abs);
      if (rel === '') return abs; // 条目就是目标根本身（如 './'）：允许
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        throw new Error('tar: path escapes destination: ' + name);
      }
      return abs;
    };

    const parser = createUstarParser({
      onDirectory(name) {
        fs.mkdirSync(safePath(name), { recursive: true, mode: MODE_DIR });
      },
      onFile(name) {
        const abs = safePath(name);
        fs.mkdirSync(path.dirname(abs), { recursive: true, mode: MODE_DIR });
        const fd = fs.openSync(abs, 'w', MODE_FILE);
        openFd = fd;
        return {
          write(buf) {
            let offset = 0;
            while (offset < buf.length) {
              offset += fs.writeSync(fd, buf, offset, buf.length - offset);
            }
          },
          end() {
            if (openFd === fd) openFd = null;
            fs.closeSync(fd);
          },
        };
      },
      onSkip(name, typeflag) {
        // 跳过必须可见（C2）：链接/设备/pax 一律不静默吞掉
        tarLog('skip typeflag=' + JSON.stringify(typeflag) + ' name=' + name);
      },
    });

    fs.mkdirSync(dest, { recursive: true, mode: MODE_DIR });

    const input = fs.createReadStream(archivePath);
    const gunzip = zlib.createGunzip();

    gunzip.on('data', (chunk) => {
      if (settled) return;
      try {
        parser.push(chunk);
      } catch (err) {
        fail(err);
      }
    });
    gunzip.on('end', () => {
      if (settled) return;
      try {
        parser.finish();
      } catch (err) {
        fail(err);
        return;
      }
      settled = true;
      // C4：skipped 必须回传（旧实现算了却丢掉 ⇒ 不完整的树在统计上「看起来正常」）
      resolve({
        files: parser.stats.files,
        bytes: parser.stats.bytes,
        dirs: parser.stats.dirs,
        skipped: parser.stats.skipped,
      });
    });
    gunzip.on('error', fail);
    input.on('error', fail);
    input.pipe(gunzip);
  });
}

module.exports = { extractTarGz, parseHeader };
