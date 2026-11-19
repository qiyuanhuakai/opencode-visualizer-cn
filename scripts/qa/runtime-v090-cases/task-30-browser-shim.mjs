// Task 30 browser entry — case-owned `@iconify/vue` stub.
//
// scripts/qa/runtime-v090-cases/task-30.mjs serves app/dev/runtime-v090/task30.ts through a Vite
// dev server whose resolve.alias maps the bare `@iconify/vue` specifier onto THIS module. The real
// `Icon` component lazily fetches icon data from the Iconify API at runtime; the QA surface must
// stay hermetic (no network egress) and the icons are decorative — every task-30 assertion reads
// data-testid / data-* attributes, never an icon. So the stub renders an inert span. This mirrors
// the product component test, which mocks `@iconify/vue` to a null component for the same reason.
//
// The LOGIC under test (the capability entry, the direct-only marker, the strict profile parser,
// the challenge/secret contract, the Slurm lifecycle feedback) is the real landed code.
import { h } from 'vue';

export const Icon = (props) => h('span', {
  class: 'icon-stub',
  'data-icon': props?.icon ?? '',
  'aria-hidden': 'true',
});

export default { Icon };
