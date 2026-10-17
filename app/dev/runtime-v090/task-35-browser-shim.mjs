// Task 35 registered QA browser shim — the two realm boundaries the real product cannot cross.
//
// scripts/qa/runtime-v090-cases/task-35.mjs serves app/dev/runtime-v090/task35.ts through a
// case-owned Vite dev server whose resolve.alias maps exactly TWO raw specifiers onto THIS module.
// Both regexes are ANCHORED to the exact raw specifier (the task-27 lesson: Vite's resolve.alias
// matches the import statement's raw specifier, so a relative or bare-shaped pattern never fires).
//
//   1. `@iconify/vue` — the real `Icon` component lazily fetches icon data from the Iconify API at
//      runtime. The QA surface must stay hermetic (no network egress) and every task-35 assertion
//      reads data-testid / data-* attributes, never an icon. The product's own component test mocks
//      @iconify/vue to a null component for the same reason (ThreadView.test.ts:49), and task 30
//      aliased the same specifier to an inert stub.
//
//   2. `node:crypto` — the REAL bridge services the Thread UI drives import node builtins at module
//      scope: bridge/runtime/threads/{threadService,participantService,checkpointService}.js:1 and
//      handoffService.js:1. None of them can execute in a browser realm without this seam, and the
//      landed unit test only reaches them through the Node-only createRequire boundary
//      (ThreadView.test.ts:51-61), which a browser entry cannot use. Tasks 26-29 alias the same
//      specifier to a browser shim for exactly this reason (task-26.mjs:261, task-27.mjs:438,
//      task-28.mjs:186, task-29.mjs:245). This shim supplies the TWO primitives those services
//      actually call:
//        * `randomUUID` — the browser realm's own crypto.randomUUID (http://127.0.0.1 is a
//          potentially-trustworthy origin, so a secure context exists), with an RFC-4122-v4
//          getRandomValues fallback. It mints the thread / participant / handoff / checkpoint /
//          op ids; no asserted value is a pinned id, only shape and equality across reads.
//        * `createHash('sha256')` — backed by the PRODUCT'S OWN pure SHA-256
//          (shared/runtime/context.js `evidenceHash`, whose header states it is "pinned against
//          node:crypto by the contract tests"). handoffService.js uses it only for internal op and
//          prompt fingerprints; no asserted value depends on it.
//      Every line of service LOGIC under test — the ladder, the operation journal,
//      projectHandoffState, the frozen read models, the budget accounting — is the real landed code.
//
// The LOGIC under test is the real landed code.
import { h } from 'vue';
import { evidenceHash } from '../../../shared/runtime/context.js';

export const Icon = (props) => h('span', {
  class: 'icon-stub',
  'data-icon': props?.icon ?? '',
  'aria-hidden': 'true',
});

export function randomUUID() {
  const webcrypto = globalThis.crypto;
  if (webcrypto !== undefined && typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID();
  if (webcrypto === undefined || typeof webcrypto.getRandomValues !== 'function') {
    throw new Error('task-35 browser shim: no crypto primitive is available in this realm');
  }
  const bytes = new Uint8Array(16);
  webcrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createHash(algorithm) {
  if (algorithm !== 'sha256') {
    throw new Error(`task-35 browser shim: unsupported hash algorithm ${String(algorithm)}`);
  }
  let input = '';
  return {
    update(chunk) {
      input += typeof chunk === 'string' ? chunk : String(chunk);
      return this;
    },
    digest(encoding) {
      if (encoding !== 'hex') {
        throw new Error(`task-35 browser shim: unsupported digest encoding ${String(encoding)}`);
      }
      return evidenceHash(input);
    },
  };
}

export default { Icon, createHash, randomUUID };
