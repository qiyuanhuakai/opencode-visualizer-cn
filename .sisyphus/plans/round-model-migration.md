# OutputPanel Round Model Migration

## TL;DR

> **Quick Summary**: Migrate OutputPanel from flat message entries to round-based grouping, where each round = top-level message (parentID===null) + all child messages. Round layout: header (timestamp+model, Fork top-right), body (chronological sub-messages with role color indicators), footer (usage, DIFF+Revert bottom-right).
> 
> **Deliverables**:
> - Round-aware `fetchHistory` that groups messages into round entries
> - Round-aware SSE handling (new rounds + append to existing rounds)
> - OutputPanel round template with header/body/footer layout
> - CSS for round containers and role indicators
> - Dead code cleanup (isFinalAnswer, userMessageToFinalKey, finish=stop filter)
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7

---

## Context

### Original Request
「ラウンドモデルに全面移行」— OutputPanel をフラットメッセージからラウンドベースモデルに全面改修。ラウンド用の枠内に、ユーザ・エージェント入り乱れての text を時系列に並べます。DIFF や Revert は、ラウンド用の枠の右下に置きます。Fork は、押したラウンド自体は Fork後のデータに含まれないので、ラウンド枠の「右上」に置きます。

### Interview Summary
**Key Discussions**:
- Round = top-level message (parentID===null) + all children (parentID===rootId)
- system-reminder rounds: display normally, no special treatment
- Text-less rounds: display them (parentID===null only)
- Role distinction: color/icon based (user=blue, assistant=green), designer's choice
- Fork: round top-right. DIFF/Revert: round bottom-right
- Session window streaming → promote flow preserved, but promoted into round's roundMessages
- Usage: display the final answer's usage (not aggregated across round)

**Research Findings**:
- `fetchHistory` (App.vue:3217) currently creates flat queue entries, filters `finish!==stop`
- `promoteFinalAnswerToOutputPanel` (App.vue:6510) creates flat entry from streaming buffer
- `registerMessageSummary` (App.vue:7277) uses `userMessageToFinalKey` map
- GC timer (App.vue:4332) rebuilds `messageIndexById` assuming 1 entry = 1 messageId
- Queue scanning functions: `applyUserMessageMetaToQueue`, `applyUserMessageTimeToQueue`, `applyMessageUsageToQueue` scan by index
- `info.parentID` is available on SSE message events (confirmed at App.vue:6487)

### Metis Review
**Identified Gaps** (addressed):
- parentID availability in list API: Task 1 validates this as gating step
- Option A vs B (container vs flat): User's design says "1ラウンド=1キューエントリ" → Option A (container with roundMessages[])
- Queue scanning functions need adaptation for nested sub-messages
- `messageIndexById` rebuild in GC timer needs round-awareness
- Text-less rounds must not be filtered out if top-level
- Usage display: show final answer's usage, not aggregated

---

## Work Objectives

### Core Objective
Replace the flat message-based rendering in OutputPanel with round-based grouping where each round is a single queue entry containing all related sub-messages, with structured header/body/footer layout.

### Concrete Deliverables
- `RoundMessage` type in App.vue
- Extended `FileReadEntry` with `isRound`, `roundId`, `roundMessages`, `roundDiffs`
- Rewritten `fetchHistory` that builds round entries from parentID grouping
- Rewritten `promoteFinalAnswerToOutputPanel` that appends to rounds
- Updated `registerMessageSummary` that updates round's `roundDiffs` directly
- Round template in OutputPanel.vue with header/body/footer
- Round CSS classes
- Removal of dead code (isFinalAnswer flag, userMessageToFinalKey map, finish=stop filter)

### Definition of Done
- [ ] `pnpm run build` succeeds with zero TypeScript errors
- [ ] OutputPanel renders rounds (not flat messages) for primary session messages
- [ ] DIFF button works on rounds using roundDiffs
- [ ] Fork/Revert buttons work with correct sessionId + messageId (from round's root user message)
- [ ] SSE live updates create/append to rounds correctly
- [ ] Non-round entries (tool windows, shells, permissions, subagent) render unchanged

### Must Have
- Round grouping by parentID===null
- Sub-messages rendered chronologically within round body
- Role color indicators (user=blue, assistant=green)
- Fork button in round header (top-right)
- DIFF + Revert buttons in round footer (bottom-right)
- Timestamp + model info in round header (top-left)
- Usage display in round footer (bottom-left)
- System-reminder rounds displayed normally
- Text-less top-level rounds displayed

### Must NOT Have (Guardrails)
- DO NOT aggregate usage statistics across round sub-messages — display final answer's usage only
- DO NOT add collapsible/expandable round UI
- DO NOT add virtual scrolling
- DO NOT refactor SSE event handler beyond promoteFinalAnswerToOutputPanel and registerMessageSummary
- DO NOT change subagent message handling, tool windows, shell windows, permission/question rendering
- DO NOT refactor `queue` from `ref<FileReadEntry[]>` to a different data structure
- DO NOT change the streaming → session-window → promote flow (only modify the promote target)
- DO NOT use text-content heuristics to identify message types — use structural fields only (parentID, role, finish)
- DO NOT add a separate `rounds` reactive data structure — rounds are queue entries with `isRound: true`

---

## Verification Strategy (MANDATORY)

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**

### Test Decision
- **Infrastructure exists**: NO (no test framework configured)
- **Automated tests**: None
- **Framework**: None
- **Primary verification**: `pnpm run build` must succeed with zero errors

### Build Verification (MANDATORY after every task)
```bash
cd /home/kikuchan/prog/vis && pnpm run build
```
Expected: Build succeeds with zero TypeScript/Vite errors.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — Sequential chain):
├── Task 1: Validate parentID in list API + Add types
├── Task 2: Rewrite fetchHistory for round grouping
├── Task 3: Rewrite SSE handlers for round model
├── Task 4: Round template + CSS in OutputPanel
├── Task 5: Wire DIFF/Fork/Revert to rounds
├── Task 6: Adapt queue scanning functions + GC timer
└── Task 7: Dead code cleanup + final build
```

Note: Due to the intertwined nature of App.vue modifications (all touching the same ~8000 line file), tasks are **sequential**. Each task builds on the previous one. Attempting parallel modifications to the same file would cause merge conflicts.

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 2, 3, 4, 5, 6 | None |
| 2 | 1 | 3, 4, 5 | None |
| 3 | 2 | 5 | None |
| 4 | 2 | 5 | None (same file concern) |
| 5 | 3, 4 | 7 | None |
| 6 | 2 | 7 | None |
| 7 | 5, 6 | None | None |

---

## TODOs

- [x] 1. Add RoundMessage Type + Extend FileReadEntry + Validate parentID

  **What to do**:
  - Add `RoundMessage` type to App.vue (after existing type definitions, ~line 275):
    ```typescript
    type RoundMessage = {
      messageId: string;
      role: 'user' | 'assistant';
      content: string;
      attachments?: MessageAttachment[];
      agent?: string;
      model?: string;
      providerId?: string;
      modelId?: string;
      variant?: string;
      time?: number;
      usage?: MessageUsage;
    };
    ```
  - Extend `FileReadEntry` (App.vue:215-275) with new optional fields:
    ```typescript
    isRound?: boolean;
    roundId?: string;
    roundMessages?: RoundMessage[];
    roundDiffs?: MessageDiffEntry[];
    ```
  - Also duplicate the `RoundMessage` type and the new `FileReadEntry` fields in `OutputPanel.vue`'s local `FileReadEntry` type (OutputPanel.vue:121-162)
  - In `fetchHistory` (App.vue:3247-3254), add a quick validation: extract `info.parentID` from the first few messages and `console.log` to confirm the field exists. This is a gating check — if parentID is not present, the entire round model approach needs reconsideration.
  - Build and verify

  **Must NOT do**:
  - Do not change any existing fields on FileReadEntry
  - Do not change any rendering logic yet
  - Do not remove any existing types

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]
    - `git-master`: Clean atomic commit after type additions
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: No UI changes in this task

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (Task 1)
  - **Blocks**: Tasks 2, 3, 4, 5, 6
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `app/App.vue:215-275` — Current `FileReadEntry` type definition. Add new fields after `isFinalAnswer?: boolean` (line 274)
  - `app/App.vue:188-213` — `MessageUsage`, `MessageAttachment`, `MessageDiffEntry` types referenced by RoundMessage
  - `app/components/OutputPanel.vue:121-162` — Duplicate FileReadEntry type that must stay in sync

  **API/Type References**:
  - `app/App.vue:6487-6489` — Proof that `info.parentID` exists on SSE message events. The list API returns the same `info` structure.
  - `app/App.vue:3248-3250` — Where message `info` is parsed in fetchHistory. This is where parentID should also be extractable.

  **Acceptance Criteria**:
  - [ ] `RoundMessage` type exists in App.vue
  - [ ] `FileReadEntry` has `isRound`, `roundId`, `roundMessages`, `roundDiffs` fields
  - [ ] OutputPanel.vue's `FileReadEntry` has matching fields
  - [ ] `pnpm run build` succeeds

  **Commit**: YES
  - Message: `feat(round): add RoundMessage type and extend FileReadEntry for round model`
  - Files: `app/App.vue`, `app/components/OutputPanel.vue`

---

- [x] 2. Rewrite fetchHistory for Round Grouping

  **What to do**:
  - Rewrite the `fetchHistory` function (App.vue:3217-3393) to group messages into rounds
  - **Phase 1**: After fetching `data` from API, extract `parentID` for each message:
    ```typescript
    const parentID = typeof info?.parentID === 'string' ? info.parentID : undefined;
    ```
    Add `parentID` to the extracted fields alongside `id`, `role`, `finish`, etc. (line 3271)
  - **Phase 2**: Group messages into rounds. After the `.map().filter()` chain (line 3257-3284):
    ```typescript
    // Build round groups: parentID===null → round root, parentID!==null → child
    const roundRoots = new Map<string, typeof history[0]>();
    const roundChildren = new Map<string, Array<typeof history[0]>>();
    for (const entry of history) {
      if (!entry.parentID) {
        // Top-level message = round root
        roundRoots.set(entry.id, entry);
        if (!roundChildren.has(entry.id)) roundChildren.set(entry.id, []);
      } else {
        // Child message
        const children = roundChildren.get(entry.parentID) ?? [];
        children.push(entry);
        roundChildren.set(entry.parentID, children);
      }
    }
    ```
  - **Phase 3**: For each round root, build a single `isRound: true` queue entry:
    - `roundId` = root message ID
    - `roundMessages` = [root message as RoundMessage] + [sorted children as RoundMessages]
    - `roundDiffs` = `extractSummaryDiffs(rootInfo)` (from the user message's info)
    - `messageId` = root message ID (for GC/index purposes)
    - `role` = root's role (usually 'user')
    - `content` = root's text (for compatibility)
    - `isFinalAnswer` = false (rounds don't use this)
    - `isMessage` = true, `isSubagentMessage` = false
  - **Phase 4**: Preserve the existing `isSubagentMessage` path unchanged — when `isSubagentMessage` is true, keep the flat entry creation (lines 3333-3367)
  - **Phase 5**: Remove the old sequential `lastUserSummaryDiffs` loop (lines 3370-3388) for non-subagent — diffs are now directly on the round via `extractSummaryDiffs` on the root user message
  - **IMPORTANT**: Do NOT filter out text-less round roots. The current `if (!text.trim() && attachments.length === 0) return null` filter (line 3263) must be relaxed for top-level messages. Top-level messages with `parentID===undefined/null` should always create rounds, even if they have no text. Only filter out text-less child messages.
  - **IMPORTANT**: The `messageIndexById` must be set for the round's primary `messageId` (roundId). Sub-message IDs need a secondary lookup — create `roundIndexByChildId` map (or store in the same `messageIndexById` pointing to the round's index).
  - **IMPORTANT**: `messageUsageByKey` should still be populated for intermediate messages (the `finish !== 'stop'` metadata storage at lines 3309-3314) so that round sub-messages have usage data available.
  - **IMPORTANT**: The `messageDiffsByKey` must still be populated. For rounds, store diffs keyed by the round's messageKey: `messageDiffsByKey.set(buildMessageKey(roundId, sessionId), roundDiffs)`.
  - Build and verify

  **Must NOT do**:
  - Do not change the subagent message path (when `isSubagentMessage` is true)
  - Do not remove the `extractMessageDiffsFromParts` call (line 3252-3254)
  - Do not change how `messageUsageByKey` is populated
  - Do not touch `promoteFinalAnswerToOutputPanel` yet (Task 3)
  - Do not touch OutputPanel template yet (Task 4)

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`git-master`]
    - `git-master`: Atomic commit for this complex rewrite
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: No UI changes, pure data logic

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (Task 2)
  - **Blocks**: Tasks 3, 4, 5
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `app/App.vue:3217-3393` — Complete current `fetchHistory` function. This is what gets rewritten.
  - `app/App.vue:3333-3367` — Current flat queue entry creation pattern. Use this as template for round entry structure.
  - `app/App.vue:3370-3388` — Current sequential `lastUserSummaryDiffs` loop. This gets replaced by direct extraction on round roots.

  **API/Type References**:
  - `app/App.vue:3247-3254` — Message structure from API: `message.info` has `id`, `role`, `finish`, `parentID`, `summary.diffs`
  - `app/App.vue:6492-6507` — `extractSummaryDiffs` function. Call this on root user message info to get `roundDiffs`.
  - `app/App.vue:188-213` — `MessageDiffEntry` type used for `roundDiffs`

  **Documentation References**:
  - `app/App.vue:3286-3307` — Meta/usage resolution pattern: `storeUserMessageMeta`, `resolveUserMessageMetaForMessage`, `resolveUserMessageDisplay`. Must be called for the round root's display metadata.

  **Acceptance Criteria**:
  - [ ] `fetchHistory` creates `isRound: true` entries for each top-level message group
  - [ ] Each round entry has `roundMessages` array with all sub-messages in chronological order
  - [ ] Each round entry has `roundDiffs` from the root user message's `summary.diffs`
  - [ ] Subagent messages still create flat entries (unchanged)
  - [ ] Text-less top-level messages still create rounds
  - [ ] `messageIndexById` maps round's messageKey to its queue index
  - [ ] `messageDiffsByKey` is populated with round diffs keyed by round's messageKey
  - [ ] `pnpm run build` succeeds

  **Commit**: YES
  - Message: `feat(round): rewrite fetchHistory to build round-grouped entries`
  - Files: `app/App.vue`

---

- [x] 3. Rewrite SSE Handlers for Round Model

  **What to do**:
  - **Modify `promoteFinalAnswerToOutputPanel`** (App.vue:6510-6584):
    - Currently: creates a new flat queue entry for each `finish=stop` assistant message
    - New behavior:
      1. If `messageFinish.parentID` exists, find the round entry for that parentID in the queue
      2. If round found: append a new `RoundMessage` to `round.roundMessages` with the assistant's content, model info, usage, etc. **Trigger Vue reactivity** by replacing the array: `round.roundMessages = [...round.roundMessages, newSubMessage]`
      3. If round NOT found (edge case: parent was sent before session was selected): fall back to creating a new round entry with this message as the first sub-message
      4. If `parentID` is undefined: create a new round entry (this is a new top-level message arriving via SSE)
    - **For the user message part**: When a new user message arrives via SSE (before any assistant response), a new round entry should be created. This happens in the message part handling (around the session-window creation logic). Add handling: when a `message.updated` event arrives for a user-role message with no parentID, create a new round entry in the queue.
    - **Keep**: The streaming session-window is separate from the round. The assistant's content is still streamed into the session window. Only on `finish=stop` does the content get added to the round's sub-messages.
  
  - **Modify `registerMessageSummary`** (App.vue:7277-7321):
    - Currently: uses `userMessageToFinalKey` to find the assistant's queue entry, then sets diffs on `messageDiffsByKey`
    - New behavior: 
      1. Find the round entry directly using the user message ID (which is the round's `roundId`/`messageId`)
      2. Update the round's `roundDiffs` directly: `roundEntry.roundDiffs = diffs`
      3. Also update `messageDiffsByKey` for the round's messageKey (for OutputPanel's `hasMessageDiffs` check)
    - This eliminates the need for `userMessageToFinalKey` map
  
  - **Handle new user messages via SSE**: In the existing SSE message part handling code, when a new message with `role=user` and no `parentID` arrives for the selected session, create a new round entry in the queue with this user message as the first `roundMessage`.

  **Must NOT do**:
  - Do not change subagent SSE handling
  - Do not change the session-window streaming mechanism
  - Do not modify `extractMessageFinish` or `extractSessionStatus`
  - Do not change how the session-window entry is created/updated during streaming
  - Do not remove `userMessageToFinalKey` yet (Task 7 cleanup)

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`git-master`]
    - `git-master`: Atomic commit for SSE handler rewrites
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: No UI changes, event handling logic

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (Task 3)
  - **Blocks**: Task 5
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `app/App.vue:6510-6584` — Current `promoteFinalAnswerToOutputPanel`. This is the main function to rewrite.
  - `app/App.vue:7277-7321` — Current `registerMessageSummary`. Simplify to direct round lookup.
  - `app/App.vue:6446-6489` — `extractMessageFinish` — extracts `parentID` from SSE events. This provides the parentID for finding which round to append to.
  - `app/App.vue:6529` — `messageUsageByKey.get(sessionWindowKey)` pattern for inheriting usage

  **API/Type References**:
  - `app/App.vue:6543-6545` — Session window entry lookup pattern: `messageIndexById.get(sessionWindowKey)` → use to get display metadata
  - `app/App.vue:6578-6581` — Current `userMessageToFinalKey` mapping. Replace with direct round lookup.

  **WHY Each Reference Matters**:
  - `promoteFinalAnswerToOutputPanel` is the bridge between streaming and OutputPanel. Its rewrite is the core of SSE round support.
  - `registerMessageSummary` must find rounds directly instead of going through `userMessageToFinalKey` indirection.
  - `extractMessageFinish` provides the `parentID` that determines which round to append to.

  **Acceptance Criteria**:
  - [ ] When `finish=stop` fires with `parentID`, the assistant message is appended to the correct round's `roundMessages`
  - [ ] When `finish=stop` fires without `parentID`, a new round entry is created
  - [ ] `registerMessageSummary` updates round's `roundDiffs` directly via round lookup
  - [ ] `messageDiffsByKey` is still populated for OutputPanel compatibility
  - [ ] Streaming session-window behavior is unchanged
  - [ ] `pnpm run build` succeeds

  **Commit**: YES
  - Message: `feat(round): rewrite SSE handlers for round-based message model`
  - Files: `app/App.vue`

---

- [x] 4. Round Template + CSS in OutputPanel

  **What to do**:
  - **OutputPanel.vue template**: Replace the current `v-for` rendering (lines 14-94) with round-aware rendering:
    ```html
    <!-- Round entries -->
    <div
      v-for="q in filteredQueue"
      :key="q.messageKey ?? q.roundId ?? q.messageId ?? q.time"
    >
      <!-- Round rendering -->
      <div v-if="q.isRound" class="output-round">
        <!-- Header: timestamp+model (left), Fork (top-right) -->
        <div class="round-header">
          <div class="round-header-left">
            <span v-if="formatRoundMeta(q)" class="round-meta">{{ formatRoundMeta(q) }}</span>
          </div>
          <div class="round-header-right">
            <button
              v-if="q.roundId && q.sessionId"
              type="button"
              class="output-entry-action"
              @click="confirmFork(q)"
            >
              fork
            </button>
          </div>
        </div>
        
        <!-- Body: sub-messages -->
        <div class="round-messages">
          <div
            v-for="(msg, idx) in (q.roundMessages ?? [])"
            :key="msg.messageId ?? idx"
            class="round-msg"
          >
            <div
              class="round-msg-indicator"
              :class="msg.role === 'user' ? 'round-msg-indicator-user' : 'round-msg-indicator-assistant'"
            />
            <div class="round-msg-content">
              <MessageViewer
                :code="msg.content"
                :lang="'markdown'"
                :theme="theme"
                :wrap-mode="'soft'"
                :gutter-mode="'none'"
                :is-message="true"
                @rendered="handleMessageRendered"
              />
              <div v-if="msg.attachments && msg.attachments.length > 0" class="output-entry-attachments">
                <img
                  v-for="item in msg.attachments"
                  :key="item.id"
                  class="output-entry-attachment"
                  :src="item.url"
                  :alt="item.filename"
                  loading="lazy"
                />
              </div>
            </div>
          </div>
        </div>
        
        <!-- Footer: usage (left), DIFF + Revert (right) -->
        <div class="round-footer">
          <div class="round-footer-left">
            <span v-if="formatRoundUsage(q)" class="output-entry-usage">{{ formatRoundUsage(q) }}</span>
          </div>
          <div class="round-footer-right">
            <button
              v-if="q.messageKey && hasMessageDiffs(q.messageKey)"
              type="button"
              class="output-entry-action output-entry-action-diff"
              @click="showRoundDiff(q)"
            >
              DIFF
            </button>
            <button
              v-if="q.roundId && q.sessionId"
              type="button"
              class="output-entry-action output-entry-action-danger"
              @click="confirmRevert(q)"
            >
              revert
            </button>
          </div>
        </div>
      </div>
      
      <!-- Non-round fallback (existing rendering) -->
      <div v-else class="output-entry" :class="{ 'is-user': q.role === 'user' }" :style="getEntryStyle(q)">
        <!-- ... existing template ... -->
      </div>
    </div>
    ```
  - **Computed filter**: Add `filteredQueue` computed:
    ```typescript
    const filteredQueue = computed(() => 
      props.queue.filter((entry) => entry.isMessage && !entry.isSubagentMessage)
    );
    ```
  - **Helper functions**: Add to OutputPanel.vue `<script setup>`:
    - `formatRoundMeta(q)`: Format timestamp + model from the last assistant sub-message (or root if no assistant)
    - `formatRoundUsage(q)`: Find the last assistant sub-message with usage data, format it
    - `showRoundDiff(q)`: Emit `show-message-diff` with round's diffs from `messageDiffs` prop
    - Update `confirmFork(q)` and `confirmRevert(q)` to use `q.roundId` as messageId and `q.sessionId`
  - **CSS**: Add round-specific styles. Design guidelines:
    - `.output-round`: Rounded border, subtle background. Visually distinct from flat entries.
    - `.round-header`: Flex row, justify space-between. Align items center.
    - `.round-messages`: Vertical list with small gap between sub-messages.
    - `.round-msg`: Flex row with indicator + content.
    - `.round-msg-indicator-user`: Small colored circle/bar, blue (#4a9eff or similar)
    - `.round-msg-indicator-assistant`: Small colored circle/bar, green (#4ade80 or similar)
    - `.round-footer`: Flex row, justify space-between. Match existing footer styling.
    - Keep existing `.output-entry` styles for non-round fallback (v-else path).
  - **Scroll behavior**: The existing `handleMessageRendered` callback and `ResizeObserver` should continue to work — round template also uses `<MessageViewer @rendered="handleMessageRendered">`.

  **Must NOT do**:
  - Do not add collapse/expand functionality
  - Do not add virtual scrolling
  - Do not change non-round entry rendering (keep as v-else)
  - Do not remove existing CSS classes used by non-round entries

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: [`frontend-ui-ux`, `git-master`]
    - `frontend-ui-ux`: Round UI layout design, role indicators, color choices
    - `git-master`: Atomic commit
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser verification (build-only verification)

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (Task 4)
  - **Blocks**: Task 5
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `app/components/OutputPanel.vue:1-116` — Complete current template. The round template replaces the main v-for block (lines 14-94).
  - `app/components/OutputPanel.vue:118-280` — Script setup section. Helper functions go here.
  - `app/components/OutputPanel.vue:265-271` — `formatMessageMeta` pattern: use as template for `formatRoundMeta`
  - `app/components/OutputPanel.vue:273-290` — `formatMessageUsage` pattern: use for `formatRoundUsage`
  - `app/components/OutputPanel.vue:233-243` — `showMessageDiff` pattern: use for `showRoundDiff`

  **API/Type References**:
  - `app/components/OutputPanel.vue:121-162` — FileReadEntry type. Must include `isRound`, `roundId`, `roundMessages`, `roundDiffs` (from Task 1).
  - `app/components/OutputPanel.vue:164-175` — Props definition. No changes needed — queue already typed as `FileReadEntry[]`.

  **WHY Each Reference Matters**:
  - The current template structure shows the exact pattern for entry rendering, events, and CSS classes to follow
  - Helper functions show formatting patterns (timestamp, usage, meta) to replicate for round versions
  - The round template MUST use the same event emissions (`fork-message`, `revert-message`, `show-message-diff`)

  **Acceptance Criteria**:
  - [ ] OutputPanel renders `isRound` entries with round-specific template
  - [ ] Round header shows timestamp + model (left) and Fork button (top-right)
  - [ ] Round body shows sub-messages with role color indicators
  - [ ] Round footer shows usage (left) and DIFF + Revert (right)
  - [ ] Non-round entries render with existing template (v-else)
  - [ ] CSS uses appropriate colors for role indicators (user=blue-ish, assistant=green-ish)
  - [ ] `pnpm run build` succeeds

  **Commit**: YES
  - Message: `feat(round): add round template and CSS to OutputPanel`
  - Files: `app/components/OutputPanel.vue`

---

- [x] 5. Wire DIFF/Fork/Revert to Rounds

  **What to do**:
  - **DIFF for rounds**: In App.vue, ensure `handleShowMessageDiff` works with round entries:
    - The round's `messageKey` should be in `messageDiffsByKey`
    - When OutputPanel emits `show-message-diff` from a round, the payload should contain the round's diffs (`roundDiffs`)
    - Verify the existing `handleShowMessageDiff` (find it in App.vue) correctly opens FileViewerWindow with tabs
  - **Fork for rounds**: The fork event should emit `{ sessionId: round.sessionId, messageId: round.roundId }`. The `roundId` is the root user message ID — this is correct for forking (fork from that user message).
  - **Revert for rounds**: Same pattern — emit `{ sessionId: round.sessionId, messageId: round.roundId }`.
  - **Ensure OutputPanel emits correctly**: Verify that `confirmFork` and `confirmRevert` in OutputPanel.vue use `q.roundId` (or `q.messageId` — which should equal the round root's ID) for the messageId in the emitted event.
  - **Test the DIFF flow end-to-end**: After `fetchHistory` populates `messageDiffsByKey` for rounds, and after `registerMessageSummary` updates it for live rounds — verify the OutputPanel's `hasMessageDiffs(q.messageKey)` returns true and `showRoundDiff` emits correct data.

  **Must NOT do**:
  - Do not change FileViewerWindow (tabs UI already works)
  - Do not change DiffViewer component
  - Do not change the diff rendering pipeline (render-worker.ts)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
  - **Skills**: [`git-master`]
    - `git-master`: Atomic commit
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: Wiring logic, not visual

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (Task 5)
  - **Blocks**: Task 7
  - **Blocked By**: Tasks 3, 4

  **References**:

  **Pattern References**:
  - `app/App.vue` — Search for `handleShowMessageDiff` to find the App.vue handler that receives the OutputPanel emission and opens FileViewerWindow
  - `app/App.vue:6578-6581` — Current `userMessageToFinalKey` mapping used by DIFF. In round model, this indirection is gone — diffs are keyed directly by round's messageKey.
  - `app/components/OutputPanel.vue:238-243` — Current `showMessageDiff` function. Adapt for rounds.
  - `app/components/OutputPanel.vue:245-249` — `confirmFork` function. Adapt to use `roundId`.
  - `app/components/OutputPanel.vue:251-255` — `confirmRevert` function. Adapt to use `roundId`.

  **API/Type References**:
  - `app/components/OutputPanel.vue:177-185` — Emit type definitions. The events remain the same shape.

  **Acceptance Criteria**:
  - [ ] DIFF button appears on rounds that have diffs
  - [ ] Clicking DIFF on a round opens FileViewerWindow with correct diff tabs
  - [ ] Fork button on round emits correct `sessionId` + `messageId` (root user message ID)
  - [ ] Revert button on round emits correct `sessionId` + `messageId` (root user message ID)
  - [ ] `pnpm run build` succeeds

  **Commit**: YES
  - Message: `feat(round): wire DIFF/Fork/Revert buttons to round model`
  - Files: `app/App.vue`, `app/components/OutputPanel.vue`

---

- [ ] 6. Adapt Queue Scanning Functions + GC Timer

  **What to do**:
  - **GC timer** (App.vue:4332-4368):
    - Currently rebuilds `messageIndexById` assuming 1 entry = 1 messageId
    - For round entries, also index sub-message IDs. After setting the round's primary key in `messageIndexById`, iterate `entry.roundMessages` and add each `msg.messageId` to a new `roundChildIndex` map (or add them to `messageIndexById` pointing to the same queue index).
    - Ensure `messageContentById` captures round content (either the root text or a combined representation)
    - Round entries never expire (same as current primary messages: `entry.isMessage && !entry.isReasoning && !entry.isSubagentMessage` returns true at line 4344)
  
  - **`applyUserMessageMetaToQueue`** (search in App.vue): 
    - Currently scans `queue.value` to find an entry by `messageId`
    - For round entries, also check if the target messageId matches any `roundMessage.messageId` within a round, and update that sub-message's metadata
  
  - **`applyUserMessageTimeToQueue`** (search in App.vue):
    - Same pattern as above — adapt to search within round entries' `roundMessages`
  
  - **`applyMessageUsageToQueue`** (search in App.vue):
    - Same pattern — find the correct round and update the relevant sub-message's usage
    - This is important for live streaming: when usage arrives via SSE for an assistant message inside a round, it should update that sub-message
  
  - **`messageContentById` updates**: When round sub-messages update, `messageContentById` should still track individual message content for compatibility.

  **Must NOT do**:
  - Do not change the GC timer interval (100ms)
  - Do not change how non-round entries are indexed
  - Do not change the filter logic for entry expiration

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`git-master`]
    - `git-master`: Atomic commit for these subtle data-flow changes
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: Backend data management, no UI

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (Task 6)
  - **Blocks**: Task 7
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `app/App.vue:4332-4368` — GC timer. Lines 4348-4363 rebuild indexes. Add round sub-message indexing here.
  - Search for `applyUserMessageMetaToQueue` in App.vue — queue scanning function to adapt
  - Search for `applyUserMessageTimeToQueue` in App.vue — queue scanning function to adapt
  - Search for `applyMessageUsageToQueue` in App.vue — queue scanning function to adapt

  **WHY Each Reference Matters**:
  - The GC timer runs every 100ms and rebuilds ALL indexes. If round sub-messages aren't indexed here, any function using `messageIndexById` to find a sub-message will fail silently.
  - The `apply*ToQueue` functions are called from SSE handlers to update queue entries. If they can't find round sub-messages, live metadata updates break.

  **Acceptance Criteria**:
  - [ ] GC timer indexes round sub-message IDs correctly
  - [ ] `applyUserMessageMetaToQueue` can update metadata for sub-messages within rounds
  - [ ] `applyUserMessageTimeToQueue` can update time for sub-messages within rounds
  - [ ] `applyMessageUsageToQueue` can update usage for sub-messages within rounds
  - [ ] Round entries never expire (same as current behavior for primary messages)
  - [ ] `pnpm run build` succeeds

  **Commit**: YES
  - Message: `feat(round): adapt queue scanning functions and GC timer for round model`
  - Files: `app/App.vue`

---

- [ ] 7. Dead Code Cleanup + Final Build Verification

  **What to do**:
  - **Remove `isFinalAnswer` flag usage**:
    - Remove `isFinalAnswer` from `FileReadEntry` type (App.vue:274)
    - Remove `isFinalAnswer` from OutputPanel.vue's `FileReadEntry` type
    - Search for all `isFinalAnswer` references and remove them. Key locations:
      - `fetchHistory` line 3356: `isFinalAnswer: isAssistantEntry && entry.finish === 'stop'`
      - `promoteFinalAnswerToOutputPanel` line 6570: `isFinalAnswer: true`
    - If any template code uses `isFinalAnswer` for conditional rendering, remove those conditions
  
  - **Remove `userMessageToFinalKey` map** (if no longer referenced after Task 3):
    - Find declaration: search for `userMessageToFinalKey` in App.vue
    - Remove the map declaration
    - Remove all `.set()` and `.get()` calls
    - `registerMessageSummary` should already use direct round lookup (Task 3)
  
  - **Remove `finish === 'stop'` filter in fetchHistory**:
    - Lines 3309-3314: `if (isSessionWindowEntry && entry.finish !== 'stop') { ... return; }` — this should already be gone after Task 2's rewrite, but verify
  
  - **Clean up the console.log from Task 1** (parentID validation log)
  
  - **Final comprehensive build**:
    ```bash
    pnpm run build
    ```

  **Must NOT do**:
  - Do not remove anything that's still referenced
  - Do not change any functional behavior — this is cleanup only
  - Do not combine with feature changes

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]
    - `git-master`: Clean atomic commit for dead code removal
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: Cleanup task, no design

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (Task 7, final)
  - **Blocks**: None
  - **Blocked By**: Tasks 5, 6

  **References**:

  **Pattern References**:
  - Search `isFinalAnswer` in `app/App.vue` and `app/components/OutputPanel.vue` — all occurrences to remove
  - Search `userMessageToFinalKey` in `app/App.vue` — all occurrences to remove
  - `app/App.vue:3309-3314` — `finish !== 'stop'` filter to verify removal

  **Acceptance Criteria**:
  - [ ] No references to `isFinalAnswer` remain in App.vue or OutputPanel.vue
  - [ ] No references to `userMessageToFinalKey` remain in App.vue
  - [ ] No console.log debug statements from Task 1 remain
  - [ ] `pnpm run build` succeeds with zero errors
  - [ ] No TypeScript unused-variable warnings related to removed code

  **Commit**: YES
  - Message: `refactor(round): remove dead code from pre-round model (isFinalAnswer, userMessageToFinalKey)`
  - Files: `app/App.vue`, `app/components/OutputPanel.vue`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(round): add RoundMessage type and extend FileReadEntry for round model` | App.vue, OutputPanel.vue | pnpm run build |
| 2 | `feat(round): rewrite fetchHistory to build round-grouped entries` | App.vue | pnpm run build |
| 3 | `feat(round): rewrite SSE handlers for round-based message model` | App.vue | pnpm run build |
| 4 | `feat(round): add round template and CSS to OutputPanel` | OutputPanel.vue | pnpm run build |
| 5 | `feat(round): wire DIFF/Fork/Revert buttons to round model` | App.vue, OutputPanel.vue | pnpm run build |
| 6 | `feat(round): adapt queue scanning functions and GC timer for round model` | App.vue | pnpm run build |
| 7 | `refactor(round): remove dead code from pre-round model` | App.vue, OutputPanel.vue | pnpm run build |

---

## Success Criteria

### Verification Commands
```bash
cd /home/kikuchan/prog/vis && pnpm run build  # Expected: Build succeeds, 0 errors
```

### Final Checklist
- [ ] All "Must Have" present (round grouping, role indicators, Fork/DIFF/Revert placement)
- [ ] All "Must NOT Have" absent (no collapse UI, no virtual scroll, no aggregated usage, no text heuristics)
- [ ] Build passes with zero TypeScript errors
- [ ] Non-round entries (tools, shells, permissions, subagent) render unchanged
- [ ] 7 atomic commits with descriptive messages
