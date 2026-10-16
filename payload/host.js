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

const os = require('os');

/** 单次调用默认超时（宿主 UI 线程卡住时不能让 Node 侧无限等待） */
const DEFAULT_TIMEOUT_MS = 10000;
/** 单次 JSON 载荷上限默认 8 MiB（与契约 §2.3 / ArkTS `capBytes` 同口径） */
const DEFAULT_CAP_BYTES = 8388608;

const handles = new Map();
let transport = null;
let capBytes = DEFAULT_CAP_BYTES;

/** 结构化错误工厂：既是 Error（可被 assert.rejects / 序列化），又带冻结字段 */
function bridgeError(fields) {
  const name = fields && fields.name !== undefined ? String(fields.name) : '';
  const error = fields && fields.error ? String(fields.error) : 'unknown';
  const err = new Error('host bridge: ' + error + (name ? ' name=' + name : ''));
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
        let parsed = raw;
        if (typeof raw === 'string') {
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            finish(reject, bridgeError({ ok: false, error: 'bad-response', name, raw }));
            return;
          }
        }
        if (!isObject(parsed)) {
          finish(reject, bridgeError({ ok: false, error: 'bad-response', name, raw: String(parsed) }));
          return;
        }
        if (parsed.ok === false) {
          // 宿主侧的结构化失败原样上抛（字段全保留：error/detail/capBytes/…）
          finish(reject, bridgeError(Object.assign({}, parsed, { ok: false, name: parsed.name || name })));
          return;
        }
        finish(resolve, parsed);
      },
      (err) => {
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

const HOST = {
  invoke,
  handle,
  unhandle,
  list,
  facts,
  setTransport,
  getTransport,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CAP_BYTES,
};

module.exports = HOST;
