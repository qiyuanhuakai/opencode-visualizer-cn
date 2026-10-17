// Task 29 registered QA case — case-owned module edge for the step transport.
//
// `bridge/runtime/transports/slurmStepTransport.js` currently imports a named export
// that `bridge/processTree.js` does not provide:
//
//     import { defaultStopProcessTree } from '../../processTree.js';
//
// `bridge/processTree.js` exports `stopProcessTree` (and `bridge/runtime/transports/
// processRelay.js` already aliases it correctly as `stopProcessTree as
// defaultStopProcessTree`). Because the specifier is missing, a plain Node ESM
// `import()` of slurmStepTransport.js fails at link time with
// "does not provide an export named 'defaultStopProcessTree'" — the same import the QA
// runner uses to load this case module and the worker protocol uses to run it. Vite/vitest
// tolerate the missing binding (it becomes `undefined`), which is why the product unit test
// passes: every test passes an explicit `stopProcessTree`, so the fallback is never called.
//
// This QA case does NOT edit the product. It registers a Node module-customization hook for
// the duration of the worker only, rewriting exactly that one import specifier to the
// correct alias so the REAL landed source (every other byte unchanged) can execute. The
// case ALSO records the raw plain-Node load failure as an explicit observation, so the
// defect is documented rather than hidden. See the DoneClaim `defects` section.
const BROKEN = "import { defaultStopProcessTree } from '../../processTree.js';";
const FIXED = "import { stopProcessTree as defaultStopProcessTree } from '../../processTree.js';";

export async function load(url, context, nextLoad) {
  if (url.endsWith('/transports/slurmStepTransport.js')) {
    const loaded = await nextLoad(url, context);
    const source = loaded.source.toString();
    if (!source.includes(BROKEN)) return loaded;
    return { ...loaded, format: 'module', source: source.replace(BROKEN, FIXED), shortCircuit: true };
  }
  return nextLoad(url, context);
}
