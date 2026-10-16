// tests/lib/log-format.mjs —— 契约 §1.3 / §2.5 的**参考实现**（测试用，不是被测对象）。
//
// 冻结格式（契约 §1.3）：
//   <stream> <epochMs> <text>\n
//   stream ∈ { out, err, sys }；epochMs = 十进制毫秒；text = 单行、不转义。
// ArkTS 侧解析口径（契约 §2.5）：无法解析的行 ⇒ { at: 0, stream: 'system', text: <原行> }，保留原文。
//
// 另提供 findHandwrittenPrefix()：检查载荷是否**自己**拼了这个前缀。
// 前缀由原生引导件的 reader 线程统一生成（契约 §1.3「实现要点」），JS 侧再拼一次会造成双重前缀。

const STREAM_MAP = { out: 'stdout', err: 'stderr', sys: 'system' };

/** 解析一行日志；返回 { parsed, mark, at, stream, text }。 */
export function parseLogLine(line) {
  const s = String(line).replace(/\r?\n$/, '');
  const m = /^(out|err|sys) (\d{1,20}) (.*)$/.exec(s);
  if (!m) {
    // §2.5：无法解析 ⇒ 保留原文，不丢信息
    return { parsed: false, mark: null, at: 0, stream: 'system', text: s };
  }
  return { parsed: true, mark: m[1], at: Number(m[2]), stream: STREAM_MAP[m[1]], text: m[3] };
}

/** 去掉行注释与块注释，避免注释里的示例字符串被误判（保持行号不变以便报错定位）。 */
export function stripComments(src) {
  const noBlock = String(src).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, (m, p1) => p1))
    .join('\n');
}

// 只覆盖「手写前缀」的几种现实写法；每条都配了测试里的正/负控（见 log-format.test.mjs）。
const HANDWRITTEN = [
  { re: /\b(?:out|err|sys)\s+\$\{/, why: '模板串里手写 "<stream> ${ts}" 前缀' },
  { re: /['"](?:out|err|sys)['"]\s*\+\s*['"]/, why: "把 stream 名与分隔符拼成前缀（'out' + ' '）" },
  { re: /['"]\s*(?:out|err|sys)\s+['"]/, why: "字面量里写死带尾空格的 stream 名（'out '）" },
  {
    re: /(?:out|err|sys)\s*\+\s*['"]\s['"]\s*\+\s*(?:Date\.now\(\)|\w*[Tt]ime\w*|\w*[Mm]s\b|\w*[Ss]tamp)/,
    why: '按 <stream> + 空格 + 时间戳 的顺序拼前缀',
  },
];

/**
 * 在源码里找「手写 `<stream> <ms> ` 前缀」的证据。
 * 返回 { line, text, why } 或 null。
 */
export function findHandwrittenPrefix(src) {
  const code = stripComments(src);
  const lines = code.split('\n');
  for (const p of HANDWRITTEN) {
    for (let i = 0; i < lines.length; i++) {
      if (p.re.test(lines[i])) return { line: i + 1, text: lines[i].trim(), why: p.why };
    }
  }
  return null;
}
