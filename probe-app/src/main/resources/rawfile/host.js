/*
 * host.js —— Node 侧宿主能力桥客户端（契约 §3.5）
 *
 * 分工（一分到底，C1）：
 *   库负责「寄存器 + 传输 + 超时 + 结构化错误」；**每个能力的实现属于消费方**（ArkTS 侧 register）。
 *   本文件是**语言边界的那一半**：Node 用 `invoke()` 调 ArkTS 处理器，ArkTS 用桥回注调用 Node 侧 `handle()` 钩子。
 *
 * 传输层是 Phase 2 的事（napi_threadsafe_function）：
 *   默认**没有**传输 ⇒ `invoke()` 必须 **reject** 结构化错误 `transport-unavailable`，
 *   **绝不**静默返回 undefined/空值（C2：反面教材是旧壳 `ExternalWeb.Open` 未注册却直接解引用）。
 *   消费方/Phase 2 用 `setTransport(fn)` 接线，签名：`async (name, argsJson) => string | object`。
 *
 * 用法：
 *   const host = require('<payload 绝对目录>/host.js');
 *   host.setTransport(async (name, argsJson) => { ... });          // Phase 2
 *   await host.invoke('perm.check', { name: 'ohos.permission.X' }); // → 已解析的对象
 *   host.handle('shutdown', async (payload) => { ... });            // Node 侧钩子
 *   host.list();                                                    // → string[]
 *   host.facts();                                                   // → 本进程事实
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
/** 单次调用默认超时（宿主 UI 线程卡住时不能让 Node 侧无限等待） */
const DEFAULT_TIMEOUT_MS = 10000;
/** 单次 JSON 载荷上限默认 8 MiB（与契约 §2.3 / ArkTS `capBytes` 同口径） */
const DEFAULT_CAP_BYTES = 8388608;

/*
 * ── 文件信箱传输（E18 主路）─────────────────────────────────────────────────
 *
 * 为什么不再走原生：Node 侧拿不到 `callHost`。两条路都实测失败 ——
 *   ① 主桥 `.so` 已由 ArkTS 侧 import 进 **libace_napi**，Node 再 `require` 只会得到
 *      `Module did not self-register`；强行导出 `napi_register_module_v1` 后 `napi_*`
 *      绑定到 libace_napi 的实现、而收到的是 Node 的 env ⇒ **整个进程静默消失**。
 *   ② 专用 addon 的 `DT_NEEDED` 里没有 libnode ⇒ 6 个 `napi_*` 无人可解，
 *      `Error relocating …: napi_create_function: symbol not found`。
 *
 * 改用**同进程文件信箱**：两侧同 UID、同文件系统视图（ArkTS 侧 `context.filesDir`），
 * 协议与宿主侧 `HostBridge.ets#startMailbox` 逐字对应：
 *
 *   Node 写 `<dir>/<id>.tmp` → rename → `<id>.req`
 *   ArkTS 每 100 ms 扫一遍：`.req` → rename 成 `.wip`（取走即改名）→ dispatch
 *                            → 写 `<id>.done`（`{ok,result}`）或 `<id>.fail`（`{ok,error}`）
 *   Node 每 100 ms 看 `.done`/`.fail` → 读完即清掉五件套
 *
 * 先写 `.tmp` 再改名，是为了让读方**要么看不到、要么看到完整的 JSON**（跨文件系统 rename
 * 非原子，但两侧同在一个沙箱内 ⇒ 同一文件系统）。
 */
/** 信箱轮询间隔；与 ArkTS 侧同口径（100 ms） */
const MAILBOX_POLL_MS = 100;
/** 信箱默认超时。宿主能力都是用户显式动作，但必须有兜底（见下方「超时随业务伸缩」） */
const MAILBOX_TIMEOUT_MS = 15000;
/**
 * 一次调用的**全部**中间态后缀。
 *
 * 清理必须全覆盖、陈旧回收也必须覆盖 `.req` —— 否则一个半截 `.req`（断电/崩溃留下）
 * 会永远排在队首：ArkTS 侧每轮都读它、每轮都因「不完整」跳过，而它既不超时也不被删
 * ⇒ **整条队列永久堵死**，直到应用重启。这个坑在宿主侧 `HostBridge.mailboxReap` 里也钉着。
 */
const MAILBOX_SUFFIXES = ['.req', '.tmp', '.wip', '.done', '.fail'];

const handles = new Map();
let transport = null;
let capBytes = DEFAULT_CAP_BYTES;
/** 文件信箱配置（null = 未接线）；`{ dir, pollMs }` */
let mailbox = null;
/** 请求序号：同一毫秒内多次调用也要有序（时间戳 + 4 位序号，字典序即 FIFO） */
let mailboxSeq = 0;

/** 结构化错误工厂：既是 Error（可被 assert.rejects / 序列化），又带冻结字段 */
function bridgeError(fields) {
  const name = fields && fields.name !== undefined ? String(fields.name) : '';
  const error = fields && fields.error ? String(fields.error) : 'unknown';
  /*
   * `detail` 也要进 message。
   *
   * 理由（本轮踩到）：日志打印的是 `error.message`，而 `detail` 只挂在对象字段上 ——
   * 于是 `bad-response` 这类"原因全在 detail 里"的失败，在日志里**只有错误名**，
   * 排查时看不出是截断、多写、还是根本换了个形状。message 只是给人读的一行，
   * 有界截断（200 字符）就够，且**不改** `code`/`detail` 字段的形状。
   */
  const detail = fields && typeof fields.detail === 'string' && fields.detail.length > 0
    ? ' detail=' + (fields.detail.length > 200 ? fields.detail.slice(0, 200) + '…' : fields.detail)
    : '';
  const err = new Error('host bridge: ' + error + (name ? ' name=' + name : '') + detail);
  Object.assign(err, { ok: false }, fields);
  if (Error.captureStackTrace) Error.captureStackTrace(err, bridgeError);
  return err;
}

/**
 * UTF-8 字节长度；**测量失败返回 null**（调用方必须按 `bad-args` 拒绝，不得猜一个偏小的值）。
 *
 * C5 / B4：与 ArkTS 侧 `HostBridge.utf8Len` 同一口径 —— 正常路径都用 UTF-8 字节数；
 * 测不出长度时两侧都**拒绝**（结构化 `bad-args`），绝不退化成 `text.length`（UTF-16 码元数，
 * 对非 ASCII 文本偏小 ⇒ 会放行超限载荷，正是两侧口径不一致的经典来源）。
 */
function byteLength(text) {
  try {
    return Buffer.byteLength(text, 'utf8');
  } catch (err) {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

/**
 * 调宿主能力（契约 §3.5）。
 * @param {string} name 能力名（v1 清单：`runtime.facts`/`perm.check`/…）
 * @param {*} [payload] 任意可 JSON 序列化的载荷（缺省 `{}`）
 * @param {{timeoutMs?: number, capBytes?: number}} [opts]
 * @returns {Promise<object>} 宿主处理器返回的对象（或字符串 JSON 解析后的对象）
 */
/** 有界片段：诊断用，绝不把整段载荷塞进日志（最怕的就是日志被一个 8 MiB 的体撑爆） */
function excerpt(value) {
  const text = typeof value === 'string' ? value : String(value);
  const head = text.slice(0, 160);
  const tail = text.length > 200 ? ' … ' + text.slice(-40) : '';
  return JSON.stringify(head + tail);
}

/**
 * 把 `JSON.parse` 的失败翻译成"位置 + 现场"。
 *
 * V8 的报错形如 `Unexpected token X in JSON at position 417`，**位置本身**就是最有力的线索
 * （前半段合法、后半段坏掉是常见形态）。只截 ±60 字符，避免把 8 MiB 的体写进日志。
 */
function parseFailureSite(raw, err) {
  const text = typeof raw === 'string' ? raw : '';
  const message = err && err.message ? String(err.message) : String(err);
  const match = /position (\d+)/.exec(message);
  if (!match) {
    return message + ' | head=' + excerpt(text);
  }
  const at = Number(match[1]);
  const from = Math.max(0, at - 60);
  const to = Math.min(text.length, at + 60);
  return message + ' | 现场@' + at + ' [' + from + ',' + to + ')=' + JSON.stringify(text.slice(from, to));
}


/**
 * 把宿主返回的原始串变成「解析后的对象」或「结构化错误」。
 *
 * **两处传输共用**（transport 与文件信箱）：解析口径只写一份 —— 否则 `ok === false`
 * 的上抛规则会在两条路径上漂开，而这类漂移只会在某个能力失败时才暴露。
 *
 * @returns {{kind: 'ok', value: object} | {kind: 'error', error: Error}}
 */
function interpretRawResponse(raw, name) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        kind: 'error',
        error: bridgeError({
          ok: false,
          error: 'bad-response',
          name,
          raw,
          // 把有界片段也放进 message：日志只打印 message，而"解析不了"最常见的两个
          // 原因是**截断**与**多写了一段**——两者都只能靠看原文区分。
          detail: 'raw[' + typeof raw + ' len=' + (typeof raw === 'string' ? raw.length : -1)
            + '] ' + parseFailureSite(raw, err),
        }),
      };
    }
  }
  if (!isObject(parsed)) {
    return { kind: 'error', error: bridgeError({ ok: false, error: 'bad-response', name, raw: String(parsed) }) };
  }
  if (parsed.ok === false) {
    // 宿主侧的结构化失败原样上抛（字段全保留：error/detail/capBytes/…）
    return {
      kind: 'error',
      error: bridgeError(Object.assign({}, parsed, { ok: false, name: parsed.name || name })),
    };
  }
  return { kind: 'ok', value: parsed };
}

function invoke(name, payload, opts) {
  return new Promise((resolve, reject) => {
    const options = opts || {};
    if (typeof name !== 'string' || name.length === 0) {
      reject(bridgeError({ ok: false, error: 'bad-name', name: String(name) }));
      return;
    }
    const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    const cap = typeof options.capBytes === 'number' && options.capBytes > 0
      ? options.capBytes
      : capBytes;

    let argsJson = '{}';
    if (payload !== undefined && payload !== null) {
      try {
        const text = JSON.stringify(payload);
        argsJson = text === undefined ? '{}' : text;
      } catch (err) {
        reject(bridgeError({ ok: false, error: 'bad-args', name, detail: String(err && err.message) }));
        return;
      }
    }
    const actual = byteLength(argsJson);
    if (actual === null) {
      // C5：测不出长度 ⇒ 结构化拒绝（与 ArkTS 侧 `bad-args` 同口径），不得用估算放行
      reject(bridgeError({
        ok: false,
        error: 'bad-args',
        name,
        detail: 'payload byte length unavailable (utf8 measure failed)',
      }));
      return;
    }
    if (actual > cap) {
      reject(bridgeError({ ok: false, error: 'payload-too-large', name, capBytes: cap, actual }));
      return;
    }
    /*
     * 文件信箱优先（E18 主路）：它自带超时与五件套清理，所以直接把 Promise 交出去，
     * **不再**走下面的 transport 分支 —— 否则两套 settle 逻辑会互相覆盖，而
     * 先 settle 的那一方会把另一方的 `.req` 留在磁盘上（变成死请求）。
     *
     * 注意：这里必须走 `interpretRawResponse`，与 transport 分支**同一套**解析口径 ——
     * 曾经这里直接 `resolve(raw)`，于是信箱路径返回的是原始 JSON **文本**、而 transport
     * 路径返回的是对象，同一个 API 两种形状（调用方各自 JSON.parse 才不会炸）。
     */
    if (mailbox !== null) {
      invokeViaMailbox(name, argsJson, timeoutMs).then((raw) => {
        const verdict = interpretRawResponse(raw, name);
        if (verdict.kind === 'error') {
          reject(verdict.error);
          return;
        }
        resolve(verdict.value);
      }, reject);
      return;
    }
    if (typeof transport !== 'function') {
      // 关键红线：没有传输层就**明确失败**，不是返回 undefined（C2）
      reject(bridgeError({
        ok: false,
        error: 'transport-unavailable',
        name,
        hint: '宿主桥传输层未接线（Phase 2：napi_threadsafe_function）；不得静默返回空值',
      }));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(bridgeError({ ok: false, error: 'timeout', name, timeoutMs }));
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    let callResult;
    try {
      callResult = transport(name, argsJson);
    } catch (err) {
      finish(reject, bridgeError({ ok: false, error: 'transport-error', name, detail: String(err && err.message ? err.message : err) }));
      return;
    }

    Promise.resolve(callResult).then(
      (raw) => {
        const verdict = interpretRawResponse(raw, name);
        if (verdict.kind === 'error') {
          finish(reject, verdict.error);
          return;
        }
        finish(resolve, verdict.value);
      },
      (err) => {
        // 传输层若已经给出结构化错误（带 error 字段），**原样上抛**：再包一层
        // transport-error 会把 'timeout' / 'mailbox-write-failed' 这类可判定的 code
        // 压成一句文本，调用方就只能靠正则猜原因。
        if (err !== null && typeof err === 'object' && err.ok === false && typeof err.error === 'string') {
          finish(reject, err);
          return;
        }
        finish(reject, bridgeError({ ok: false, error: 'transport-error', name, detail: String(err && err.message ? err.message : err) }));
      }
    );
  });
}

/** 注册 Node 侧钩子（宿主经桥回注调用；同名覆盖） */
function handle(name, fn) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('host.handle: name 必须是非空字符串');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('host.handle: fn 必须是函数');
  }
  handles.set(name, fn);
}

/** 注销 Node 侧钩子；返回是否真的删掉了（与 ArkTS `unregister` 同语义） */
function unhandle(name) {
  return handles.delete(name);
}

/** 已注册的 Node 侧钩子名（诊断用，不返回实现） */
function list() {
  return Array.from(handles.keys());
}

/** 本进程事实（供 `/diag`、日志与消费方诊断面板） */
function facts() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    execArgv: process.execArgv,
    pid: process.pid,
    versions: process.versions,
    HOME: process.env.HOME || '',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    cwd: process.cwd(),
  };
}

/** Phase 2 接线点：`fn(name, argsJson) -> Promise<string|object>`；传 null 可断开（诊断用） */
function setTransport(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new TypeError('host.setTransport: 需要一个函数或 null');
  }
  transport = fn;
}

function getTransport() {
  return transport;
}

// ── 文件信箱：Node 侧实现（E18 主路；协议见文件顶部）──────────────────────────

/**
 * 清掉一次调用的全部中间文件。
 *
 * 幂等且**永不抛**：清理失败不是调用失败的理由，宿主侧的陈旧回收会兜底
 * （它覆盖 `.req/.tmp/.wip/.done/.fail` 全套，见 `HostBridge.mailboxReap`）。
 */
function cleanupMailbox(dir, id) {
  for (const suffix of MAILBOX_SUFFIXES) {
    try {
      const p = path.join(dir, id + suffix);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      // 忽略：陈旧回收兜底
    }
  }
}

/**
 * 接线文件信箱。
 *
 * **返回结构化结果而不是布尔**：目录不可写是最可能的失败，而"为什么没接上"必须能被
 * 调用方原样写进日志（C2：不得静默失败）。`opts.pollMs` 与宿主侧同口径，默认 100 ms。
 *
 * @param {string} dir 信箱目录（宿主的 `context.filesDir` 下；两侧必须指向同一路径）
 * @param {{pollMs?: number}} [opts]
 * @returns {{ok: boolean, error?: string, detail?: string, dir?: string, pollMs?: number}}
 */
function useFileMailbox(dir, opts) {
  if (typeof dir !== 'string' || dir.length === 0) {
    mailbox = null;
    return { ok: false, error: 'mailbox-unavailable', detail: 'dir 为空串' };
  }
  const options = opts || {};
  const pollMs = typeof options.pollMs === 'number' && options.pollMs > 0
    ? options.pollMs
    : MAILBOX_POLL_MS;
  try {
    // recursive 对已存在目录是 no-op；宿主侧也会建一次（幂等，谁先起来都不会失败）
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    mailbox = null;
    return {
      ok: false,
      error: 'mailbox-unavailable',
      detail: String(err && err.message ? err.message : err),
      dir,
    };
  }
  mailbox = { dir, pollMs };
  return { ok: true, dir, pollMs };
}

/** 断开文件信箱（诊断用；断开后 `invoke()` 回落到 transport 或结构化失败） */
function disableFileMailbox() {
  mailbox = null;
}

/** 信箱状态（诊断用；不含任何载荷内容） */
function mailboxInfo() {
  if (mailbox === null) {
    return { wired: false };
  }
  return { wired: true, dir: mailbox.dir, pollMs: mailbox.pollMs };
}

/**
 * 通过文件信箱做一次调用：写 `.req` → 轮询 `.done`/`.fail` → 清理五件套。
 *
 * 三条纪律：
 *  1. **超时也要清理** —— 否则宿主侧稍后处理完会写回一个没人读的 `.done`，
 *     而残留的 `.req` 会占住队首（半截文件那条坑的另一面）。
 *  2. `.done` 里的 `result` 是宿主 `dispatch()` 的**原样返回串**，不在这里解析语义：
 *     解析与 `ok === false` 的上抛统一由 `invoke()` 做（一处口径，两侧不会漂）。
 *  3. 桶里只保留 4 位序号：同一毫秒内的多次调用靠序号有序，宿主按名字排序取最小者
 *     ⇒ 天然 FIFO，且不需要额外的锁文件。
 *
 * @returns {Promise<string>} 宿主 dispatch() 的原始返回串（已转义的 JSON 文本）
 */
function invokeViaMailbox(name, argsJson, timeoutMs) {
  return new Promise((resolve, reject) => {
    const box = mailbox;
    if (box === null) {
      reject(bridgeError({ ok: false, error: 'transport-unavailable', name }));
      return;
    }
    const budget = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : MAILBOX_TIMEOUT_MS;
    mailboxSeq = (mailboxSeq + 1) % 10000;
    // 13 位时间戳（到 2286 年都不溢出）+ 4 位序号 ⇒ 字典序 == 时间序
    const id = 'req-' + String(Date.now()).padStart(13, '0') + '-' + String(mailboxSeq).padStart(4, '0');
    const tmpPath = path.join(box.dir, id + '.tmp');
    const reqPath = path.join(box.dir, id + '.req');
    const donePath = path.join(box.dir, id + '.done');
    const failPath = path.join(box.dir, id + '.fail');
    const body = JSON.stringify({ name, args: argsJson, pid: process.pid, ts: Date.now() });
    try {
      // 先写 .tmp 再改名：读方要么看不到、要么看到完整 JSON
      fs.writeFileSync(tmpPath, body, 'utf8');
      fs.renameSync(tmpPath, reqPath);
    } catch (err) {
      cleanupMailbox(box.dir, id);
      reject(bridgeError({
        ok: false,
        error: 'mailbox-write-failed',
        name,
        dir: box.dir,
        detail: String(err && err.message ? err.message : err),
      }));
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanupMailbox(box.dir, id);
      fn(value);
    };
    const deadline = Date.now() + budget;
    const poll = () => {
      if (settled) return;
      if (fs.existsSync(donePath)) {
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(donePath, 'utf8'));
        } catch (err) {
          parsed = null; // 半截文件：下一轮再读（宿主侧也是 .tmp+rename，理论不该出现）
        }
        if (parsed !== null) {
          const raw = parsed.result;
          finish(resolve, typeof raw === 'string' ? raw : JSON.stringify(raw === undefined ? null : raw));
          return;
        }
      }
      if (fs.existsSync(failPath)) {
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(failPath, 'utf8'));
        } catch (err) {
          parsed = null;
        }
        if (parsed !== null) {
          finish(reject, bridgeError({
            ok: false,
            error: String((parsed && parsed.error) || 'host-failed'),
            name,
            detail: String((parsed && parsed.detail) || ''),
          }));
          return;
        }
      }
      if (Date.now() > deadline) {
        finish(reject, bridgeError({ ok: false, error: 'timeout', name, timeoutMs: budget, dir: box.dir, id }));
        return;
      }
      setTimeout(poll, box.pollMs);
    };
    poll();
  });
}
const HOST = {
  invoke,
  handle,
  unhandle,
  list,
  facts,
  setTransport,
  getTransport,
  useFileMailbox,
  disableFileMailbox,
  mailboxInfo,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CAP_BYTES,
  MAILBOX_POLL_MS,
  MAILBOX_TIMEOUT_MS,
};

module.exports = HOST;
