import { beforeEach, describe, expect, it } from 'vitest';

import { createStreamPatcher } from './streamPatch';

// Fixture row strings mirror what the upstream token→row module emits
// (see render-worker.ts buildCodeRows): plain rows and gutter-carrying rows.
const plainRow = (n: number) => `<div class="code-row"><span class="line">line ${n}</span></div>`;
const gutterRow = (n: number) =>
  `<div class="code-row"><span class="code-gutter">${n}</span><span class="code-gutter">${n}</span><span class="line">line ${n}</span></div>`;
const classedRow = (cls: string, text: string) =>
  `<div class="code-row ${cls}"><span class="line">${text}</span></div>`;

const ROW_RE = /<div class="code-row[^"]*">[\s\S]*?<\/div>/g;

const WRAPPER = '<div class="code-host"><pre class="shiki"><code></code></pre></div>';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  container.innerHTML = WRAPPER;
});

describe('createStreamPatcher structure', () => {
  it('locates the existing pre.shiki > code inside the code-host wrapper', () => {
    // Given: a container already holding the standard worker-produced wrapper.
    const patcher = createStreamPatcher(container);

    // When: a batch of stable rows arrives.
    patcher.applyBatch({ stableRows: [plainRow(1)], unstableRow: null });

    // Then: rows land inside the pre-existing code element, wrapper untouched.
    const code = container.querySelector('pre.shiki > code');
    expect(code).not.toBeNull();
    expect(code?.querySelectorAll('.code-row')).toHaveLength(1);
    expect(container.firstElementChild?.className).toBe('code-host');
  });

  it('creates the pre.shiki > code structure when the container is empty', () => {
    // Given: an empty container with no pre-existing shiki structure.
    const empty = document.createElement('div');
    const patcher = createStreamPatcher(empty);

    // When: a batch arrives.
    patcher.applyBatch({ stableRows: [plainRow(1)], unstableRow: null });

    // Then: the patcher built the standard structure and appended the row.
    expect(empty.querySelector('pre.shiki > code')).not.toBeNull();
    expect(empty.querySelectorAll('.code-row')).toHaveLength(1);
  });
});

describe('applyBatch incremental semantics', () => {
  it('appends stable rows after committed rows and keeps one trailing unstable row across 5 batches', () => {
    // Given: a patcher on the standard wrapper.
    const patcher = createStreamPatcher(container);

    // When: five ordered batches arrive, mixing stable completions and unstable repaints.
    patcher.applyBatch({ stableRows: [plainRow(1), plainRow(2)], unstableRow: classedRow('u', 'partial 1') });
    patcher.applyBatch({ stableRows: [gutterRow(3)], unstableRow: classedRow('u', 'partial 2') });
    patcher.applyBatch({ stableRows: [], unstableRow: classedRow('u', 'partial 3') });
    patcher.applyBatch({ stableRows: [plainRow(4), plainRow(5)], unstableRow: null });
    patcher.applyBatch({ stableRows: [plainRow(6)], unstableRow: classedRow('u', 'partial 5') });

    // Then: committed rows are append-only and exactly one trailing unstable row remains.
    const rows = container.querySelectorAll('.code-row');
    expect(rows).toHaveLength(7);

    // And: order and content match the committed sequence plus the latest unstable repaint.
    const expected = [
      plainRow(1),
      plainRow(2),
      gutterRow(3),
      plainRow(4),
      plainRow(5),
      plainRow(6),
      classedRow('u', 'partial 5'),
    ];
    const serialized = Array.from(rows).map((el) => el.outerHTML);
    expect(serialized).toEqual(expected);
  });

  it('keeps serialized innerHTML compatible with the CodeRenderer row-extraction regex', () => {
    // Given: a patcher that received stable rows plus a trailing unstable row.
    const patcher = createStreamPatcher(container);
    patcher.applyBatch({ stableRows: [plainRow(1), gutterRow(2), classedRow('line-added', 'added')], unstableRow: null });
    patcher.applyBatch({ stableRows: [plainRow(3)], unstableRow: plainRow(4) });

    // When: the CodeRenderer.vue regex runs over the serialized container HTML.
    const matches = container.innerHTML.match(ROW_RE);

    // Then: it extracts exactly the committed row set (stable + trailing unstable).
    expect(matches).toEqual([plainRow(1), gutterRow(2), classedRow('line-added', 'added'), plainRow(3), plainRow(4)]);
  });

  it('does not accumulate duplicate rows when the unstable row repaints repeatedly', () => {
    // Given: a patcher that received one stable row.
    const patcher = createStreamPatcher(container);
    patcher.applyBatch({ stableRows: [plainRow(1)], unstableRow: classedRow('u', 'v1') });

    // When: the trailing unstable row repaints several times with no new stable rows.
    patcher.applyBatch({ stableRows: [], unstableRow: classedRow('u', 'v2') });
    patcher.applyBatch({ stableRows: [], unstableRow: classedRow('u', 'v3') });
    patcher.applyBatch({ stableRows: [], unstableRow: classedRow('u', 'v4') });

    // Then: the row count stays constant and the trailing row holds the latest paint.
    const rows = container.querySelectorAll('.code-row');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toBe('v4');
  });

  it('supports a first batch with empty stableRows and only an unstable row (mid-line first chunk)', () => {
    // Given: a fresh patcher.
    const patcher = createStreamPatcher(container);

    // When: the first stream chunk completes no line and only carries a partial row.
    patcher.applyBatch({ stableRows: [], unstableRow: classedRow('u', 'partial') });

    // Then: exactly the unstable row is present.
    const rows = container.querySelectorAll('.code-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe('partial');
  });
});

describe('finalize', () => {
  it('replaces the entire container content wholesale and rejects further applyBatch calls', () => {
    // Given: a patcher mid-stream with committed and unstable rows.
    const patcher = createStreamPatcher(container);
    patcher.applyBatch({ stableRows: [plainRow(1)], unstableRow: classedRow('u', 'partial') });

    // When: the final single-shot HTML converges the stream.
    const finalHtml = '<div class="code-host"><pre class="shiki"><code>FINAL</code></pre></div>';
    patcher.finalize(finalHtml);

    // Then: the container content is exactly the final HTML.
    expect(container.innerHTML).toBe(finalHtml);

    // And: the patcher is terminal — further batches throw instead of corrupting output.
    expect(() => patcher.applyBatch({ stableRows: [plainRow(2)], unstableRow: null })).toThrow(/finalize/);
  });
});

describe('reset', () => {
  it('clears a partial stream back to the empty initial structure', () => {
    // Given: a patcher mid-stream.
    const patcher = createStreamPatcher(container);
    patcher.applyBatch({ stableRows: [plainRow(1), plainRow(2)], unstableRow: classedRow('u', 'partial') });

    // When: the stream is reset.
    patcher.reset();

    // Then: no rows remain but the pre.shiki > code structure is intact.
    expect(container.querySelectorAll('.code-row')).toHaveLength(0);
    expect(container.querySelector('pre.shiki > code')).not.toBeNull();

    // And: the patcher accepts new batches starting from a clean slate.
    patcher.applyBatch({ stableRows: [plainRow(9)], unstableRow: null });
    expect(container.querySelectorAll('.code-row')).toHaveLength(1);
  });

  it('recovers usability after finalize', () => {
    // Given: a finalized patcher.
    const patcher = createStreamPatcher(container);
    patcher.finalize('<div class="code-host"><pre class="shiki"><code>FINAL</code></pre></div>');

    // When: reset is called and a new stream begins.
    patcher.reset();
    patcher.applyBatch({ stableRows: [plainRow(1)], unstableRow: null });

    // Then: batches apply normally again.
    expect(container.querySelectorAll('.code-row')).toHaveLength(1);
  });
});
