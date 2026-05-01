本文档聚焦 VIS 前端在**长列表渲染**、**代码/二进制内容展示**以及**Web Worker 渲染卸载**三个维度上的性能优化策略。核心目标是在保持交互流畅的前提下，最小化 DOM 节点数量、降低主线程渲染压力，并通过分层缓存机制避免重复计算。

---

## 1. 架构概览：三层虚拟滚动体系

VIS 的虚拟滚动并非单一实现，而是根据数据形态和容器特征分化为三种模式，分别服务于会话线程列表、文件树与代码/二进制查看器。

| 层级 | 应用场景 | 核心组件 | 高度策略 | 可见性计算 |
|:---|:---|:---|:---|:---|
| **线程级虚拟滚动** | 会话消息列表（>20 条线程） | `OutputPanel.vue` | 动态测量 + 预估回退 | 二分查找 + `ResizeObserver` |
| **树形虚拟滚动** | Git 文件树（大量文件/目录） | `TreeView.vue` | 固定行高（24px） | 直接索引切片 |
| **代码/二进制虚拟滚动** | 大文件代码、Hex 查看器 | `CodeRenderer.vue`、`HexRenderer.vue` | 固定行高（20px） | 直接索引切片 |

三种模式共享同一套底层思想——**只渲染视口内的节点，通过占位 spacer 维持滚动条语义**，但在高度确定性与测量机制上存在差异。线程级列表因消息内容高度不可预估，采用动态测量方案；而文件树与代码查看器因行高恒定，可直接通过数学计算完成偏移定位。

Sources: [OutputPanel.vue](app/components/OutputPanel.vue#L286-L353), [TreeView.vue](app/components/TreeView.vue#L471-L967), [CodeRenderer.vue](app/components/renderers/CodeRenderer.vue#L109-L158), [HexRenderer.vue](app/components/renderers/HexRenderer.vue#L26-L71)

---

## 2. 线程级虚拟滚动：动态高度与自适应测量

### 2.1 切换阈值与双模式渲染

`OutputPanel` 在会话线程数 ≤20 时退化为普通列表渲染，避免虚拟滚动带来的测量开销；超过阈值后启用绝对定位的虚拟滚动容器。

```vue
<!-- 普通模式：≤20 条线程 -->
<template v-if="!shouldVirtualize">
  <ThreadBlock v-for="root in visibleRoots" ... />
</template>

<!-- 虚拟滚动模式：>20 条线程 -->
<template v-else>
  <div class="virtual-scroll-spacer" :style="{ height: `${totalContentHeight}px` }">
    <div v-for="root in visibleThreadRoots"
         :style="{ transform: `translateY(${threadOffsets.map.get(root.id)}px)` }">
      <ThreadBlock ... />
    </div>
  </div>
</template>
```

`shouldVirtualize` 的计算逻辑直接基于 `visibleRoots.value.length > 20`，这是一个经验阈值，平衡了 DOM 节点数量与虚拟滚动自身计算成本。

Sources: [OutputPanel.vue](app/components/OutputPanel.vue#L24-L94)

### 2.2 动态高度测量机制

线程内容高度无法预先得知，因此系统采用 **"预估高度 + 实际测量 + 缓存"** 的三阶段策略：

- **预估回退**：`THREAD_ESTIMATED_HEIGHT = 240`，用于首次渲染或测量未完成时的占位计算。
- **ResizeObserver 动态采集**：每个可见线程根节点被绑定独立的 `ResizeObserver`，在内容变化时捕获 `contentRect.height`。
- **RAF 批量更新**：测量结果不立即写入响应式状态，而是先收集到 `pendingHeightUpdates` Map 中，在下一帧统一合并到 `measuredHeights`，避免频繁触发 Vue 重新计算 `threadOffsets`。

```ts
threadResizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const rootId = observedThreadElements.get(entry.target);
    pendingHeightUpdates.set(rootId, entry.contentRect.height);
  }
  if (heightUpdateFrameId !== null) return;
  heightUpdateFrameId = requestAnimationFrame(() => {
    const newHeights = new Map(measuredHeights.value);
    for (const [rootId, height] of pendingHeightUpdates) {
      newHeights.set(rootId, height);
    }
    measuredHeights.value = newHeights; // 单次赋值，减少响应式抖动
  });
});
```

Sources: [OutputPanel.vue](app/components/OutputPanel.vue#L407-L464)

### 2.3 二分查找确定可见区间

`visibleThreadRoots` 的计算采用二分查找定位首个可见项，时间复杂度 O(log n)，而非线性扫描：

```ts
// 查找第一个底部超过 scrollTop 的项
while (lo < hi) {
  const mid = (lo + hi) >> 1;
  const itemBottom = offsets[mid] + getThreadHeight(roots[mid]);
  if (itemBottom < scrollTop.value) lo = mid + 1;
  else hi = mid;
}
const startIdx = Math.max(0, lo - OVERSCAN_COUNT);
```

随后线性扩展至视口底部并附加 `OVERSCAN_COUNT = 2` 的缓冲行，防止快速滚动时出现空白。`threadOffsets` 是一个基于 `visibleRoots` 和 `measuredHeights` 的派生计算属性，每次高度缓存更新时会自动重算。

Sources: [OutputPanel.vue](app/components/OutputPanel.vue#L324-L353)

### 2.4 滚动事件节流

面板滚动事件通过 `requestAnimationFrame` 节流，避免每帧多次触发 Vue 计算：

```ts
function onPanelScroll() {
  pendingScrollTop = panel.scrollTop;
  if (scrollFrameId !== null) return;
  scrollFrameId = requestAnimationFrame(() => {
    scrollFrameId = null;
    scrollTop.value = pendingScrollTop;
  });
}
```

Sources: [OutputPanel.vue](app/components/OutputPanel.vue#L367-L378)

---

## 3. 树形虚拟滚动：固定行高的高效切片

`TreeView` 处理的是 Git 文件树，其节点高度恒定（`ROW_HEIGHT = 24`），因此无需 `ResizeObserver`，直接通过数学运算完成偏移。

### 3.1 扁平化与缓存

树形数据首先被深度优先展开为 `flattenedRows` 数组，同时引入**记忆化缓存**避免重复遍历：

```ts
let cachedFlattenedRows: VirtualRow[] | null = null;
let cachedFlattenedRowsKey = '';

const flattenedRows = computed<VirtualRow[]>(() => {
  const key = flattenedRowsKey.value;
  if (cachedFlattenedRowsKey === key && cachedFlattenedRows !== null) {
    return cachedFlattenedRows;
  }
  // ... 重新计算 ...
  cachedFlattenedRows = rows;
  cachedFlattenedRowsKey = key;
  return rows;
});
```

缓存键由展开状态、搜索查询、视图模式和选中路径共同决定，确保在无关状态变化时直接命中缓存。

Sources: [TreeView.vue](app/components/TreeView.vue#L491-L955)

### 3.2 可见行切片

```ts
const visibleRows = computed(() => {
  const startIdx = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(
    flattenedRows.value.length,
    Math.ceil((scrollTop.value + containerHeight.value) / ROW_HEIGHT) + OVERSCAN
  );
  return flattenedRows.value.slice(startIdx, endIdx);
});
```

每个可见行通过 `transform: translateY(${row.offsetY}px)` 绝对定位，`offsetY` 在扁平化阶段已预计算为 `index * ROW_HEIGHT`。`OVERSCAN = 5` 提供了比线程级更大的缓冲，因为文件树滚动通常更频繁。

Sources: [TreeView.vue](app/components/TreeView.vue#L959-L967)

---

## 4. 代码与二进制虚拟滚动

### 4.1 代码渲染器（CodeRenderer）

`CodeRenderer` 在代码行数超过 `VIRTUAL_SCROLL_THRESHOLD = 500` 时启用虚拟滚动。与树形类似，它采用固定行高（`ROW_HEIGHT = 20`），但额外处理了**语法高亮后的 HTML 行提取**：

```ts
function extractCodeRows(html: string) {
  const matches = html.match(/<div class="code-row[^"]*">[\s\S]*?<\/div>/g);
  return matches?.map((rowHtml, index) => ({ key: `rendered-${index}`, html: rowHtml })) ?? [];
}
```

语法高亮由 Web Worker 异步完成，返回完整 HTML 后被拆分为独立行，再进入虚拟滚动管道。`OVERSCAN_ROWS = 10` 的设置比文件树更激进，因为代码查看器中的快速滚动对空白更敏感。

Sources: [CodeRenderer.vue](app/components/renderers/CodeRenderer.vue#L110-L158)

### 4.2 二进制 Hex 渲染器（HexRenderer）

`HexRenderer` 采用几乎相同的虚拟滚动模型，但数据源为原始字节数组，每行固定 16 字节：

```ts
const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 20;
const OVERSCAN_ROWS = 8;

const visibleRows = computed(() => {
  for (let i = startRow.value; i < endRow.value; i++) {
    const byteOffset = i * BYTES_PER_ROW;
    const rowBytes = props.bytes.slice(byteOffset, byteOffset + BYTES_PER_ROW);
    const html = hexdump(rowBytes, { color: 'html' });
    rows.push({ index: i, html });
  }
  return rows;
});
```

Hex 渲染不依赖 Worker，直接在主线程通过 `@kikuchan/hexdump` 生成带颜色标注的 HTML，因此虚拟滚动的主要收益在于减少 DOM 节点而非卸载计算。

Sources: [HexRenderer.vue](app/components/renderers/HexRenderer.vue#L26-L71)

---

## 5. 自动滚动跟随：智能感知用户意图

`useAutoScroller` 组合式函数为输出面板和悬浮窗提供滚动跟随能力，其核心挑战在于**区分程序触发的滚动与用户主动操作**。

### 5.1 四种滚动模式

| 模式 | 行为 |
|:---|:---|
| `follow` | 默认跟随底部；用户上滚后暂停，回到底部后恢复 |
| `force` | 强制始终跟随，无视用户操作 |
| `manual` | 完全手动控制 |
| `none` | 禁用所有自动滚动 |

### 5.2 用户意图检测

系统通过多通道输入判断用户是否正在主动交互：

- **滚轮事件**：`wheel` 监听器捕获 `deltaY < 0`（向上滚动）时立即取消跟随。
- **触摸与指针**：`touchmove` 和 `pointerdown` 标记用户意图时间戳，240ms 窗口期内的滚动被视为用户操作。
- **干预容差**：`INTERVENTION_TOLERANCE_PX = 2`，允许程序设置 scrollTop 后微小的观测偏差，避免误判。

```ts
function onScroll() {
  if (lastSetScrollTop >= 0 &&
      Math.abs(el.scrollTop - lastSetScrollTop) <= INTERVENTION_TOLERANCE_PX) {
    return; // 程序设置的滚动，忽略
  }
  if (delta < -INTERVENTION_TOLERANCE_PX && hasUserIntent) {
    isFollowing.value = false; // 用户主动上滚，暂停跟随
  }
}
```

Sources: [useAutoScroller.ts](app/composables/useAutoScroller.ts#L245-L267)

### 5.3 双引擎平滑滚动

支持 `raf`（自定义 requestAnimationFrame 插值）和 `native`（CSS `scroll-behavior: smooth`）两种引擎：

- **RAF 引擎**：以 `SCROLL_SPEED_PX_PER_MS = 1.5` 匀速插值，每帧检测用户是否干预（通过对比 `el.scrollTop` 与 `lastSetScrollTop`），一旦发现偏差立即终止动画。
- **Native 引擎**：依赖浏览器原生平滑滚动，通过 `scrollend` 事件和 1500ms 超时双重保险恢复跟踪状态。

```ts
if (smoothEngine === 'native') {
  el.scrollTo({ top: target, behavior: 'smooth' });
  startNativeSmoothMonitor(el); // 监听 scrollend + timeout
} else {
  // RAF 自定义插值
  function frame(now: number) {
    const step = SCROLL_SPEED_PX_PER_MS * dt;
    el.scrollTop = Math.min(el.scrollTop + step, target);
    rafId = requestAnimationFrame(frame);
  }
}
```

Sources: [useAutoScroller.ts](app/composables/useAutoScroller.ts#L115-L220)

---

## 6. Web Worker 渲染池：卸载主线程

Markdown 与代码语法高亮是 CPU 密集型任务，VIS 通过 `render-worker.ts` 将其完全卸载到 Web Worker。

### 6.1 动态 Worker 池大小

```ts
const WORKER_POOL_SIZE = typeof navigator !== 'undefined'
  ? Math.min(8, Math.max(4, navigator.hardwareConcurrency || 4))
  : 4;
```

Worker 数量根据 `navigator.hardwareConcurrency` 动态调整，范围限定在 4-8 之间，避免过度并行导致上下文切换开销。

Sources: [workerRenderer.ts](app/utils/workerRenderer.ts#L46-L48)

### 6.2 轮询调度与请求去重

Worker 采用简单轮询（round-robin）分发请求，配合两层缓存机制：

- **内存缓存**：`completedCache` 上限 200 条，LRU 淘汰。缓存键由代码内容、语言、主题、行号限制等全部参数拼接而成。
- **Worker 内缓存**：`codeHtmlCache` 和 `mdHighlightCache` 上限 512 条，用于缓存 Shiki 的 `codeToHtml` 结果，避免重复语法解析。

```ts
function getCacheKey(payload: RenderRequest) {
  return [
    payload.code, payload.patch ?? '', payload.after ?? '',
    payload.lang, payload.theme, payload.gutterMode ?? '',
    // ... 更多参数
  ].join('\u0000');
}
```

Sources: [workerRenderer.ts](app/components/renderers/MarkdownRenderer.vue#L40-L43), [render-worker.ts](app/workers/render-worker.ts#L89-L100)

### 6.3 可取消的渲染任务

`startRenderWorkerHtml` 返回带有 `cancel()` 方法的 `RenderTask`，在组件卸载或输入快速变化时取消过时请求：

```ts
const task = startRenderWorkerHtml({ id, code, lang, theme });
cancelActiveRender = task.cancel;
task.promise.then((html) => { /* ... */ });
```

取消操作通过 `RenderCancelledError` 拒绝 Promise，调用方可以安全忽略该错误而不触发错误 UI。

Sources: [workerRenderer.ts](app/utils/workerRenderer.ts#L148-L194), [MarkdownRenderer.vue](app/components/renderers/MarkdownRenderer.vue#L100-L140)

### 6.4 渲染状态全局追踪

`useRenderState` 维护全局的 `_pendingWorkerRenders` 计数器，供 UI 层（如加载指示器）观测当前排队中的渲染任务数量：

```ts
const _pendingWorkerRenders = ref(0);
export const pendingWorkerRenders = readonly(_pendingWorkerRenders);

export function incrementPendingRenders(): void { _pendingWorkerRenders.value++; }
export function decrementPendingRenders(): void { if (_pendingWorkerRenders.value > 0) _pendingWorkerRenders.value--; }
```

Sources: [useRenderState.ts](app/composables/useRenderState.ts#L1-L22)

---

## 7. 预渲染与懒加载的协同

### 7.1 助手消息预渲染（useAssistantPreRenderer）

`OutputPanel` 通过 `useAssistantPreRenderer` 在消息数据到达时**提前**触发 Markdown Worker 渲染，而非等到 `ThreadBlock` 挂载后才执行。这消除了虚拟滚动带来的"首次可见才渲染"延迟。

```ts
watchEffect(() => {
  for (const root of options.visibleRoots.value) {
    if (!options.hasAssistantMessages(root)) continue;
    const content = options.getFinalAnswerContent(root);
    // 去重：相同内容、主题、语言不再重复提交
    if (last && last.content === content && last.theme === theme) continue;
    submitAssistantRender(root.id, answerId, content);
  }
});
```

渲染结果缓存到 `assistantHtmlCache`，当 `ThreadBlock` 进入视口时直接读取已完成的 HTML。

Sources: [useAssistantPreRenderer.ts](app/composables/useAssistantPreRenderer.ts#L91-L122)

### 7.2 图片懒加载

消息附件中的图片使用原生 `loading="lazy"` 属性，交由浏览器 Intersection Observer 自动管理加载时机：

```vue
<img v-for="item in userAttachments"
     :src="item.url"
     :alt="item.filename"
     loading="lazy"
     @click="emit('open-image', { url: item.url, filename: item.filename })" />
```

这是 VIS 中最轻量的懒加载形式，无需自定义可见性追踪逻辑。

Sources: [ThreadBlock.vue](app/components/ThreadBlock.vue#L37-L46)

### 7.3 渲染器条件挂载（MessageViewer）

`MessageViewer` 根据当前激活的模式（Markdown / Code）通过 `v-if` 与 `v-show` 组合控制渲染器生命周期：

- **`v-if`（挂载控制）**：仅在支持对应模式时创建组件实例。
- **`v-show`（可见性控制）**：当允许模式切换（`allowModeToggle`）时，两个渲染器同时挂载但仅显示当前模式，避免切换时的重新初始化开销。

```ts
const shouldMountMarkdownRenderer = computed(
  () => supportsMarkdownMode.value && (keepBothRenderersMounted.value || showMarkdownRenderer.value)
);
const shouldMountCodeRenderer = computed(
  () => supportsCodeMode.value && (keepBothRenderersMounted.value || showCodeRenderer.value)
);
```

Sources: [MessageViewer.vue](app/components/MessageViewer.vue#L112-L121)

---

## 8. 虚拟滚动到底部的稳定性处理

虚拟滚动的一个经典问题是 `scrollHeight` 在高度测量完成前不准确，导致"滚动到底部"行为失效。`OutputPanel` 的 `scrollToBottom` 实现了 RAF 轮询补偿：

```ts
function scrollToBottom() {
  let attempts = 0;
  const maxAttempts = 20;
  let lastScrollTop = -1;

  function tick() {
    if (attempts >= maxAttempts) return;
    attempts++;
    panel.scrollTop = panel.scrollHeight;
    if (panel.scrollTop === lastScrollTop) return; // 已稳定
    lastScrollTop = panel.scrollTop;
    requestAnimationFrame(tick);
  }
  tick();
}
```

该机制在内容动态增长（如流式消息）时尤为重要，因为每次高度更新都可能改变 `scrollHeight`，需要持续对齐直到位置收敛。

Sources: [OutputPanel.vue](app/components/OutputPanel.vue#L538-L565)

---

## 9. 相关页面导航

虚拟滚动与懒加载优化并非孤立存在，它与以下系统紧密协作：

- **[Web Worker 渲染池与缓存策略](10-web-worker-xuan-ran-chi-yu-huan-cun-ce-lue)** — 深入 Worker 内部语法高亮、diff 生成与缓存淘汰策略。
- **[消息流处理与增量更新](14-xiao-xi-liu-chu-li-yu-zeng-liang-geng-xin)** — 理解消息数据如何流入 `OutputPanel` 并触发虚拟滚动重算。
- **[悬浮窗生命周期与 Dock 管理](15-xuan-fu-chuang-sheng-ming-zhou-qi-yu-dock-guan-li)** — `FloatingWindow` 同样使用 `useAutoScroller` 实现内容跟随。
- **[文件树构建与 Git 状态集成](18-wen-jian-shu-gou-jian-yu-git-zhuang-tai-ji-cheng)** — `TreeView` 的虚拟滚动数据源与 Git 状态过滤逻辑。