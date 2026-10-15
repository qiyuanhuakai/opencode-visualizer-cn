// Task 24 browser entry — case-owned `@iconify/vue` stub.
//
// scripts/qa/runtime-v090-cases/task-24.mjs serves app/dev/runtime-v090/task24.ts
// through a Vite dev server whose resolve.alias maps the bare `@iconify/vue`
// specifier onto THIS module. The real `Icon` component lazily fetches icon data
// from the Iconify API at runtime; the QA surface must stay hermetic (no network
// egress) and the icons are decorative — every task-24 assertion reads
// data-testid / data-* attributes or rendered text, never an icon. This mirrors
// the product component test (ConnectionEntry.test.ts), which mocks
// `@iconify/vue` to a null component for the same reason.
//
// The LOGIC under test (the single connection entry, the migration wizard, the
// legacy export/import pipeline, the workspace capability decision, the workspace
// control routing and the bridge-version report) is the real landed code.
import { h } from 'vue';

export const Icon = (props) => h('span', {
  class: 'icon-stub',
  'data-icon': props?.icon ?? '',
  'aria-hidden': 'true',
});

export default { Icon };
