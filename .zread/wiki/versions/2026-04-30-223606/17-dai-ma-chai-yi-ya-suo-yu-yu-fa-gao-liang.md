本页聚焦于 VIS 中代码差异（Diff）的展示与渲染体系，涵盖两个核心能力：一是通过 **Unified Diff 压缩算法** 将大段 Patch 裁剪为紧凑的上下文视图，二是利用 **Shiki 语法高亮引擎** 在 Web Worker 中完成高性能的代码着色与差异渲染。两者共同支撑了消息流中的代码变更展示、Git 差异查看、工具输出渲染等高频场景。

---

## 差异压缩：从冗长 Patch 到紧凑视图

当后端返回的 Patch 包含大量未变更的上下文行时，直接渲染会导致视觉噪音与性能浪费。`compactUnifiedDiffPatch` 函数通过解析 Unified Diff 的 Hunk 结构，将无关上下文裁剪至指定行数，同时重新计算行号偏移，保证输出仍为合法的标准 Patch 格式。

压缩流程分为三步：**元数据剥离** → **Hunk 解析** → **上下文裁剪**。首先过滤掉 `diff --git`、`Index:`、`---`、`+++` 等元数据行；随后用正则 `@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@` 提取每个 Hunk 的起始行号与内容体；最后在每个 Hunk 内部定位所有变更行（以 `+` 或 `-` 开头，排除 `+++`/`---`），将相距较远的变更拆分为独立组，每组仅保留变更点前后 `contextLines`（默认 3 行）的上下文。若变更点间距超过 `contextLines * 2 + 1`，则视为独立 Hunk 分别输出。被裁剪掉的上下文行通过 `countOldLines` 与 `countNewLines` 重新累加行号偏移，确保新生成的 Hunk Header 行号准确。

该算法在 `render-worker.ts` 中的调用策略具有条件性：仅当请求携带 `patch` 且未显式提供 `after` 时才会触发压缩。这意味着当用户同时提供修改前/后完整文本时，系统会直接使用原始 Patch 进行渲染，避免二次压缩可能带来的信息丢失。

Sources: [diffCompression.ts](app/utils/diffCompression.ts#L7-L35), [diffCompression.ts](app/utils/diffCompression.ts#L61-L107), [render-worker.ts](app/workers/render-worker.ts#L1009-L1021)

---

## 差异生成：Myers 算法与 Patch 应用

除了接收外部 Patch，渲染 Worker 还内置了完整的差异生成与应用能力。`generateUnifiedDiff` 实现基于 **Myers 差分算法**（O(ND) 时间复杂度、线性空间），通过追踪编辑图的最短路径生成标准 Unified Diff。算法使用 `Int32Array` 存储 V 向量，并记录每一层搜索的快照（trace），随后回溯得到完整的编辑脚本（插入/删除/相等）。编辑脚本再按 `contextLines` 分组为 Hunk，输出与 `compactUnifiedDiffPatch` 兼容的 Patch 文本。

`applyPatchToCode` 则负责将 Unified Diff 应用到原始代码上。它逐行解析 Patch，根据 `+`（插入）、`-`（删除）、` `（保留）三种指令操作代码行数组，并维护一个 `offset` 变量来跟踪因插入/删除导致的行号漂移。该函数在 `renderRequest` 中用于从 `code + patch` 派生出 `after` 文本，为后续的语法高亮与差异对比提供完整的修改后内容。

Sources: [render-worker.ts](app/workers/render-worker.ts#L240-L392), [render-worker.ts](app/workers/render-worker.ts#L394-L429)

---

## 语法高亮：Shiki 引擎与语言加载策略

渲染 Worker 以 **Shiki** 为核心语法高亮引擎，通过 `createHighlighter` 创建单例高亮器实例。为控制内存与加载时间，高亮器初始仅加载 `text` 语言与当前主题，其余语言按需求动态加载。`resolveLanguage` 函数实现了多候选回退机制：对于 `shellscript` 会依次尝试 `bash` → `shellscript` → `sh` → `text`；对于 `tsx` 会尝试 `tsx` → `typescript` → `text`。这种映射关系通过 `languageCandidates` 集中管理，确保即使后端返回的语言标识与 Shiki 内置名称不完全一致，也能找到最接近的语法定义。

语言加载分为两条路径：**内置 Bundle** 与 **自定义 Grammar**。Shiki 的 `bundledLanguages` 与 `allBundledLanguages` 覆盖了主流编程语言，通过动态 `import()` 按需加载。对于生物信息学领域特有的格式（FASTA、FASTQ、SAM、VCF、BED、GTF），项目内置了对应的 TextMate Grammar JSON 文件，在 `tryLoadLanguage` 中直接作为自定义语法注入高亮器。加载失败的语言会被记入 `failedLanguageCache`，避免重复请求。

主题切换时，高亮器实例、已加载语言缓存、失败缓存及两个 HTML 缓存（`codeHtmlCache` 与 `mdHighlightCache`）会被全部重置，确保主题变更后的渲染结果一致。

Sources: [render-worker.ts](app/workers/render-worker.ts#L102-L112), [render-worker.ts](app/workers/render-worker.ts#L114-L179), [render-worker.ts](app/workers/render-worker.ts#L80-L87)

---

## 差异渲染：双版本语法高亮与行级样式映射

差异渲染的核心挑战在于：同一行代码在修改前/后可能分属不同语法上下文，直接对 Diff 文本做高亮会丢失原始文件的语法结构。`buildDiffHtmlFromCode` 采用 **双版本独立高亮** 策略：分别对 `before` 与 `after` 完整文本调用 `safeCodeToHtml` 生成 Shiki HTML，再通过 `extractShikiLines` 提取出按行封装的 `<span class="line">` 节点。随后，Worker 逐行遍历 Diff 文本，根据行首符号（`+`/`-`/` `/`@@`）决定从 `beforeLines` 还是 `afterLines` 中取出对应的高亮行，并附加差异样式类（`line-added`/`line-removed`/`line-hunk`）。

行号 gutter 的生成由 `buildDiffGutterLines` 负责，它解析 Diff 中的 `@@` Header 来初始化旧/新文件行号计数器，随后根据每行的类型（插入/删除/上下文）分别递增 `oldLine` 或 `newLine`，输出两个对齐的字符串数组。`wrapDiffRows` 将高亮行、gutter 值与样式类组合为最终的 HTML 行结构，支持 `none`/`single`/`double` 三种 gutter 模式。`double` 模式同时显示旧/新两侧行号，是差异查看器的默认配置。

若传入的 `before` 为空但 `diff` 非空，`reconstructSourcesFromDiff` 会从 Patch 中逆向重建修改前/后的完整文本，按行号索引填充到对应位置，缺失行留空。这使得仅提供 Patch 的场景也能获得完整的语法高亮效果。

Sources: [render-worker.ts](app/workers/render-worker.ts#L690-L777), [render-worker.ts](app/workers/render-worker.ts#L457-L517), [render-worker.ts](app/workers/render-worker.ts#L641-L688)

---

## Worker 渲染池与请求调度

所有语法高亮与差异渲染任务均在 **Dedicated Web Worker** 中异步执行，避免阻塞主线程。`workerRenderer.ts` 管理了一个大小为 `Math.min(8, Math.max(4, navigator.hardwareConcurrency || 4))` 的 Worker 池，采用轮询（round-robin）策略分发请求。每个渲染请求携带唯一 `id`，Worker 完成计算后通过 `postMessage` 返回 HTML 字符串。

渲染结果通过 **两级缓存** 加速：Worker 层使用 `completedCache`（LRU 淘汰，上限 200 条），以渲染参数的全量拼接为 Key；Worker 内部还有 `codeHtmlCache`（上限 512 条）用于缓存单段代码的 Shiki 输出，`mdHighlightCache` 用于缓存 Markdown 代码块的高亮结果。`useCodeRender` Composable 在 Vue 组件层面封装了请求生命周期：监听参数变化时自动递增 `requestId`，取消旧请求，仅当返回结果的 `requestId` 与当前一致时才更新 DOM，防止竞态条件下的内容错乱。

Sources: [workerRenderer.ts](app/utils/workerRenderer.ts#L46-L55), [workerRenderer.ts](app/utils/workerRenderer.ts#L127-L146), [useCodeRender.ts](app/utils/useCodeRender.ts#L26-L91)

---

## 差异查看器组件架构

差异渲染的 UI 层由 `DiffViewer` → `DiffRenderer` → `CodeContent` 三级组件构成。`DiffViewer` 作为容器，提供文件标签页（多文件 Diff 时）与视图模式切换（原始/修改后/差异），并通过 `toMessageDiffViewerEntry` 将后端返回的 `MessageDiffEntry` 归一化为 `{file, before, after, patch}` 结构。当 `before`/`after` 均存在时优先使用完整文本本地生成 Diff；否则回退到 Patch 解析或重建。

`DiffRenderer` 负责将当前激活的标签页数据组装为 `CodeRenderParams`，通过 `useCodeRender` 触发 Worker 渲染，并处理加载态与错误态。`CodeContent` 作为纯展示组件，根据 `variant="diff"` 应用差异专属样式：新增行左侧有绿色竖线（`#2ea043`）与半透明绿色背景，删除行左侧有红色竖线（`#f85149`）与半透明红色背景，Hunk Header 行则为蓝色标识。这些样式通过 `:deep()` 穿透 Scoped CSS 注入到 Worker 返回的 HTML 中。

Sources: [DiffViewer.vue](app/components/viewers/DiffViewer.vue#L1-L51), [DiffRenderer.vue](app/components/renderers/DiffRenderer.vue#L1-L21), [CodeContent.vue](app/components/CodeContent.vue#L138-L174)

---

## 消息流差异集成

在消息流（Message Stream）中，用户消息可能携带 `diffs` 数组，每个条目包含文件路径、Patch 文本及可选的修改前/后内容。`useMessages` 的 `getDiffs` 方法将这些原始数据提取为 `MessageDiffEntry[]`，`ThreadBlock` 组件在检测到存在差异时向父级发射 `show-message-diff` 事件。`App.vue` 中的 `handleShowMessageDiff` 将差异条目转换为 `DiffViewer` 的 `diffTabs` 属性，并在悬浮窗中打开差异查看器。

对于 `apply_patch` 工具输出，`toolRenderers.ts` 的 `extractPatch` 函数从工具状态元数据中提取 `before`/`after`/`patch` 三要素，生成带文件标签的 Diff 视图。`renderEditDiffHtml` 辅助函数则封装了向 Worker 提交差异渲染请求的标准参数模板（`gutterMode: 'double'`、`lang` 由文件路径推断）。

Sources: [useMessages.ts](app/composables/useMessages.ts#L364-L378), [ThreadBlock.vue](app/components/ThreadBlock.vue#L255-L258), [App.vue](app/App.vue#L7386-L7426), [toolRenderers.ts](app/utils/toolRenderers.ts#L96-L189)

---

## 相关页面

- 如需了解 Worker 渲染池的缓存淘汰与并发调度细节，请参阅 [Web Worker 渲染池与缓存策略](10-web-worker-xuan-ran-chi-yu-huan-cun-ce-lue)。
- 如需了解悬浮窗的生命周期管理与 Dock 交互，请参阅 [悬浮窗生命周期与 Dock 管理](15-xuan-fu-chuang-sheng-ming-zhou-qi-yu-dock-guan-li)。
- 如需了解消息流的增量更新与状态管理，请参阅 [消息流处理与增量更新](14-xiao-xi-liu-chu-li-yu-zeng-liang-geng-xin)。