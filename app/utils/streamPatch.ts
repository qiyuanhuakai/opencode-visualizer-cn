/**
 * Pure DOM batch patcher for streaming code highlight.
 *
 * Incrementally maintains the children of the `<code>` element inside the
 * standard worker-produced wrapper:
 *
 *   <div class="code-host"><pre class="shiki"><code>{rows}</code></pre></div>
 *
 * Caller contract:
 * - Batches arrive in stream order. The patcher does NOT deduplicate or
 *   reorder batches; feeding the same batch twice appends its stable rows
 *   twice. Ordering guarantees belong to the feeding composable.
 * - Each `stableRows` entry is a complete `<div class="code-row...">...</div>`
 *   HTML string produced upstream by the token→row module.
 * - Committed (stable) rows are append-only. The single trailing "unstable"
 *   row repaints in place: each batch replaces the previous unstable row
 *   before appending new stable rows, so the unstable row is always the
 *   last child of `<code>`.
 * - `finalize(finalHtml)` swaps the whole container content to the
 *   single-shot converged output and makes the patcher terminal: any later
 *   `applyBatch` throws. `reset()` is the only way back to a usable state.
 */
export interface StreamBatch {
  readonly stableRows: readonly string[];
  readonly unstableRow: string | null;
}

export interface StreamPatcher {
  applyBatch(batch: StreamBatch): void;
  reset(): void;
  finalize(finalHtml: string): void;
}

function locateOrCreateCode(container: HTMLElement): HTMLElement {
  const existing = container.querySelector<HTMLElement>('pre.shiki > code');
  if (existing) return existing;
  container.replaceChildren();
  const pre = document.createElement('pre');
  pre.className = 'shiki';
  const code = document.createElement('code');
  pre.appendChild(code);
  container.appendChild(pre);
  return code;
}

export function createStreamPatcher(container: HTMLElement): StreamPatcher {
  let codeEl = locateOrCreateCode(container);
  let unstableEl: Element | null = null;
  let finalized = false;

  function applyBatch(batch: StreamBatch): void {
    if (finalized) {
      throw new Error('streamPatcher: applyBatch() called after finalize()');
    }
    // The previous unstable row is replaced, never appended after: drop it
    // before committing new stable rows so ordering stays stable-then-unstable.
    unstableEl?.remove();
    unstableEl = null;
    if (batch.stableRows.length > 0) {
      codeEl.insertAdjacentHTML('beforeend', batch.stableRows.join(''));
    }
    if (batch.unstableRow !== null) {
      codeEl.insertAdjacentHTML('beforeend', batch.unstableRow);
      unstableEl = codeEl.lastElementChild;
    }
  }

  function reset(): void {
    finalized = false;
    unstableEl = null;
    codeEl = locateOrCreateCode(container);
    codeEl.replaceChildren();
  }

  function finalize(finalHtml: string): void {
    // Wholesale convergence swap: the one place innerHTML assignment is used,
    // since the entire container content is replaced by single-shot output.
    container.innerHTML = finalHtml;
    finalized = true;
    unstableEl = null;
  }

  return { applyBatch, reset, finalize };
}
