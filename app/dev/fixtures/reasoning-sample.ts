/**
 * Reasoning-text fixture for the growing-markdown baseline bench
 * (branch feat/shiki-v4, dev-only).
 *
 * Simulates a realistic "thinking/working" floating-window stream: mixed
 * Chinese+English prose, headings, one list, inline code, and three fenced
 * code blocks (ts / python / bash). The python fence intentionally stays
 * UNCLOSED through a long mid-section of the stream — every delta in that
 * stretch renders a document whose last code block is still open, which is
 * the common real-world shape while an agent prints a long code block.
 *
 * Exports:
 *   REASONING_FULL_TEXT — the final markdown (~5-7KB).
 *   REASONING_DELTAS    — deterministic append-chunk sequence (mulberry32
 *                         seeded PRNG; ~800-1500 chunks of varied small
 *                         sizes, split at arbitrary character boundaries —
 *                         mid-line and mid-fence-marker splits included).
 *   REASONING_STATS     — structural facts used by the bench/runner.
 *
 * The module THROWS at import time if any structural constraint is violated
 * (count drift, lost mid-marker splits, fence accounting). A failing import
 * surfaces as a bench-page fatal, so fixture bugs fail loudly instead of
 * producing silently wrong numbers.
 */

// ---------------------------------------------------------------------------
// Full markdown text. Backticks are escaped for the template literal.
// ---------------------------------------------------------------------------
export const REASONING_FULL_TEXT = `# 推理记录：悬浮窗渲染卡顿定位

我们先梳理一下现象：thinking 悬浮窗在长会话里滚动明显掉帧，尤其是当 reasoning 文本增长到几千字之后。初步怀疑是每次 delta 都触发了全量 markdown 渲染 — every append triggers a full re-render of the entire buffer, so total cost grows faster than the text itself. 这个假设需要数据支撑，不能凭直觉下结论。

先确认渲染路径：\`Reasoning.vue\` 把累积文本传给 \`MessageViewer\`，后者走 \`MarkdownRenderer\`，最终调用 worker 里的 \`startRenderWorkerHtml\`，lang 为 \`markdown\`。也就是说 worker 每次都会对整段文本做一次完整的 markdown-it parse，再交给 shiki 高亮 fenced code block。主线程拿到 HTML 之后通过 v-html 整体替换 — a full innerHTML swap, no incremental patching at all. 渲染管线上的每一环都是全量的，这正是我们怀疑的性能瓶颈。

## 问题分析 Problem Analysis

为什么延迟会随文本增长？设最终文本长度为 n，delta 总数为 K。第 k 次 delta 到达时，worker 需要解析的输入是前 k 段的拼接，长度约为 (k/K)·n。于是总解析量 = Σ (k/K)·n ≈ n·K/2 —— 既和文本长度成正比，也和 delta 次数成正比。This is the classic re-parse trap: the worker parses bytes it has already parsed, K times over. 更糟的是主线程的 DOM 替换同样是全量的，mutation observer 会看到整棵子树被移除再插入，layout 也要对整个新子树重算。

对比一下 code 渲染路径：streaming tokenizer 只处理新增 suffix，\`batchToRows\` 加 \`createStreamPatcher\` 只动变化的行，稳定行完全不碰。markdown 路径目前没有任何增量机制，所以它是下一步优化的目标。在动手之前，需要回答三个问题：per-delta 延迟随文本增长的斜率是多少；累计发往 worker 的字节量有多少；主线程全量替换贡献了多少毫秒。

## 现状代码 Current Implementation

渲染入口大致是这样的（简化后）：

\`\`\`ts
// app/components/renderers/MarkdownRenderer.vue (simplified)
async function startRender() {
  const code = props.code ?? '';
  const task = startRenderWorkerHtml({
    id: nextId,
    code,            // full accumulated markdown, every single time
    lang: 'markdown',
    theme: DEFAULT_SYNTAX_THEME,
    gutterMode: 'none',
  });
  cancelActiveRender = task.cancel;
  const html = await task.promise;   // full re-parse in the worker
  state.html = html;                 // full innerHTML replace via v-html
}
\`\`\`

注意 \`cancelActiveRender\` 只能跳过过期的 DOM 写入，worker 里已经排队的 parse 并不会被取消 — cancellation drops the DOM write, not the CPU burn. 消息越积越多时，worker 池里会同时跑着好几个针对不同前缀的全量 parse，彼此都是浪费。

## 测量计划 Measurement Plan

在写任何优化代码之前，先把 baseline 钉死。计划如下：

- 构造一个混合中英的 reasoning fixture，包含 headings、inline \`code\` 和三个 fenced block（ts / python / bash）
- 用确定性的 PRNG 把全文切成 800–1500 个小 delta，允许在任意字符边界切开（包括 fence marker 的正中间）
- 每个 delta 都走当前生产路径：full text → worker full parse → innerHTML replace，串行喂入以便逐 delta 计时
- 记录 per-delta 的 worker round-trip、主线程 replace 耗时、cumulative bytes sent 和 DOM 全量替换次数
- 三次 fresh-page 运行取中位数，按 fixture 前 / 中 / 后三段分别算 p50 和 p95

这样后续 streaming markdown 实现就能和同一 fixture、同一切片、同一测量代码的 baseline 直接对比。Numbers first, opinions second. 没有 baseline 的优化都是自我感动。

## 成本估算 Cost Estimate

顺手写了个小脚本估算理论上下限。注意下面这个 fence 会在很长一段流里保持未闭合状态，用来模拟真实输出里常见的大段代码块：

\`\`\`python
# estimate_parse_cost.py — 估算全量重解析的总字节量
# The fence stays OPEN for a long stretch of the stream on purpose:
# markdown-it must treat everything below as one code block until the
# closing marker finally arrives hundreds of deltas later.
import math
from dataclasses import dataclass

@dataclass(frozen=True)
class Delta:
    index: int
    text: str

def cumulative_parse_bytes(deltas: list[Delta]) -> int:
    """Sum of bytes sent to the worker across the whole stream."""
    total = 0
    acc = ''
    for d in deltas:
        acc += d.text
        # 每个 delta 都把完整前缀发给 worker —— this is the quadratic term
        total += len(acc.encode('utf-8'))
    return total

def streamed_parse_bytes(deltas: list[Delta]) -> int:
    """Ideal incremental path: parse each new suffix exactly once."""
    return sum(len(d.text.encode('utf-8')) for d in deltas)

def ratio(deltas: list[Delta]) -> float:
    base = streamed_parse_bytes(deltas)
    assert base > 0, 'fixture must be non-empty'
    return cumulative_parse_bytes(deltas) / base

def main() -> None:
    sample = 'growing markdown 混合中文 ' * 400
    step = 7
    fake = [Delta(i, sample[i:i + step]) for i in range(0, len(sample), step)]
    r = ratio(fake)
    # 定性结论 qualitative takeaway:
    #   ratio ≈ K / 2, where K = number of deltas.
    #   K=1000 → roughly 500x more bytes parsed than an incremental design.
    #   这就是为什么要做 streaming markdown。
    print(f'ratio={r:.1f} over {len(fake)} deltas, log2={math.log2(r):.2f}')

if __name__ == '__main__':
    main()
\`\`\`

上面这段脚本只是估算，真实耗时还要看 markdown-it 的 parse 常数因子、shiki 对 fenced 块的高亮开销，以及主线程 HTML 替换带来的 layout 成本。估算给出的只是数量级判断：字节量随 K 线性放大，这一条已经足够说明问题了。

## 另一个角度 Alternative View

也要考虑 cancel 带来的影响：生产环境里 delta 到达得比渲染快时，\`MarkdownRenderer\` 会 cancel 上一个还在飞的请求。但 cancel 只是让主线程忽略结果，worker 池里的 worker 照样把整段文本 parse 完 — the pool still burns the CPU, the result is simply discarded. 所以串行测量得到的 baseline 其实是乐观下界；真实负载下重叠请求只会让累计 worker 耗时更高，不会让数字更好看。

另一个容易忽视的点是 GC 压力：每次全量替换都会产生一棵被丢弃的 DOM 子树和一大段 HTML 字符串，长会话里这些短命对象会持续给 minor GC 加压。这部分成本不在本次 baseline 的测量范围内，但值得在后续优化时一并观察。

## 验证方式 Verification

等 baseline 稳定复现之后，跑一遍完整 bench 留档：

\`\`\`bash
# 启动 dev server（127.0.0.1:5173），然后：
node scripts/qa/stream-bench.mjs --scenario markdown
# 原始数据与汇总写到 /tmp/stream-bench-markdown/
ls -la /tmp/stream-bench-markdown/summary.json
\`\`\`

三次 fresh-page 运行的中位数应该彼此接近；如果 run 间差异很大，先怀疑 warmup 不充分或者机器上有别的负载，不要直接采信。Sanity checks 必须全绿：metric 字段缺失或为零都说明 harness 本身有 bug。

## 结论 Conclusion

基线的意义不在于数字本身，而在于它定义了“现状”这条线。之后的 streaming markdown 实现只需要证明两件事：per-delta latency 不再随文本长度增长（曲线变平），且 cumulative bytes 从 n·K/2 降到接近 n。Once the baseline is pinned, the optimization has a concrete target to beat. 数据到手之前，一切关于快慢的争论都只是猜测。`;

// ---------------------------------------------------------------------------
// Deterministic delta slicing.
// mulberry32 PRNG: same seed → same sequence on every page load, so the
// baseline is reproducible run-over-run and comparable to a future
// streaming implementation fed the identical sequence.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DELTA_SEED = 0x5eed5;
const MIN_DELTAS = 800;
const MAX_DELTAS = 1500;

function buildDeltas(full: string): string[] {
  const rand = mulberry32(DELTA_SEED);
  const deltas: string[] = [];
  let pos = 0;
  while (pos < full.length) {
    const r = rand();
    // Varied small sizes: mostly 2-6 chars, some 7-14, a few 15-36.
    let size: number;
    if (r < 0.75) size = 2 + Math.floor(rand() * 5);
    else if (r < 0.95) size = 7 + Math.floor(rand() * 8);
    else size = 15 + Math.floor(rand() * 22);
    size = Math.min(size, full.length - pos);
    deltas.push(full.slice(pos, pos + size));
    pos += size;
  }
  return deltas;
}

export const REASONING_DELTAS: string[] = buildDeltas(REASONING_FULL_TEXT);

// ---------------------------------------------------------------------------
// Structural validation (runs at import; throws on any violation).
// ---------------------------------------------------------------------------
function fenceMarkerIndices(text: string): number[] {
  const indices: number[] = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf('```', from);
    if (idx === -1) return indices;
    indices.push(idx);
    from = idx + 3;
  }
}

function validateFixture(full: string, deltas: string[]): void {
  if (full.length < 5000 || full.length > 7000) {
    throw new Error(`fixture size must be 5000-7000 chars, got ${full.length}`);
  }
  if (deltas.join('') !== full) {
    throw new Error('deltas must concatenate to the full text exactly');
  }
  if (deltas.length < MIN_DELTAS || deltas.length > MAX_DELTAS) {
    throw new Error(`delta count must be ${MIN_DELTAS}-${MAX_DELTAS}, got ${deltas.length}`);
  }
  const fences = fenceMarkerIndices(full);
  if (fences.length !== 6) {
    throw new Error(`expected exactly 3 fenced blocks (6 markers), got ${fences.length}`);
  }
  // The python fence (2nd marker = opener of block 2) must open in the first
  // half and its closer (3rd marker) must land well into the second half, so
  // a long mid-section of the stream renders with an unclosed fence.
  const openFrac = fences[2] / full.length;
  const closeFrac = fences[3] / full.length;
  if (openFrac > 0.5 || closeFrac < 0.55) {
    throw new Error(
      `python fence must span a long mid-section (open=${openFrac.toFixed(2)}, close=${closeFrac.toFixed(2)})`,
    );
  }
  // Delta-boundary checks: boundaries are the cumulative ends of deltas
  // (except the final one, which is end-of-text).
  const boundaries: number[] = [];
  let acc = 0;
  for (let i = 0; i < deltas.length - 1; i += 1) {
    acc += deltas[i].length;
    boundaries.push(acc);
  }
  // At least one boundary strictly inside a ``` fence marker.
  const splitsFenceMarker = boundaries.some(
    (b) => full[b - 1] === '`' && full[b] === '`',
  );
  if (!splitsFenceMarker) {
    throw new Error('no delta boundary splits a fence marker (seed unsuitable)');
  }
  // At least one mid-line split (neither side of the boundary is a newline).
  const splitsMidLine = boundaries.some(
    (b) => full[b - 1] !== '\n' && full[b] !== '\n',
  );
  if (!splitsMidLine) {
    throw new Error('no mid-line delta boundary (seed unsuitable)');
  }
  // Fraction of the stream that renders with an unclosed fence: count
  // prefixes whose fence-marker count is odd.
  let unclosed = 0;
  let pos = 0;
  for (const d of deltas) {
    pos += d.length;
    let count = 0;
    for (const f of fences) {
      if (f < pos) count += 1;
    }
    if (count % 2 === 1) unclosed += 1;
  }
  const frac = unclosed / deltas.length;
  if (frac < 0.15 || frac > 0.45) {
    throw new Error(`unclosed-fence delta fraction ${frac.toFixed(2)} outside 0.15-0.45`);
  }
}

validateFixture(REASONING_FULL_TEXT, REASONING_DELTAS);

export const REASONING_STATS = {
  chars: REASONING_FULL_TEXT.length,
  deltaCount: REASONING_DELTAS.length,
  fenceMarkers: fenceMarkerIndices(REASONING_FULL_TEXT).length,
};
