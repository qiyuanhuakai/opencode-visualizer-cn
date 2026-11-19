import { pathToFileURL } from 'node:url';

// The QA browser kernel (omowright) is the operator's browser-automation
// script, not a repository dependency: it is not in package.json and not
// vendored. The cases used to import it from a hardcoded personal cache path,
// so no clean checkout and no CI machine could run the browser stage at all —
// the import failed with ERR_MODULE_NOT_FOUND before a single assertion.
// Resolve the kernel from explicit configuration instead, and fail with an
// actionable precheck error before anything is spawned.
const KERNEL_VARIABLE = 'VIS_QA_BROWSER_KERNEL';
export function browserKernelSpecifier(env = process.env) {
  const specifier = env[KERNEL_VARIABLE];
  if (typeof specifier !== 'string' || specifier.length === 0) {
    throw new Error(`${KERNEL_VARIABLE} is not set: the QA browser kernel is not a repository dependency, point it at the omowright.mjs of the browser automation tooling`);
  }
  return specifier;
}
export async function loadBrowserKernel(env = process.env) {
  const specifier = browserKernelSpecifier(env);
  const loaded = await import(pathToFileURL(specifier).href);
  if (typeof loaded.loadOmowright !== 'function') throw new Error(`${specifier} does not export loadOmowright`);
  // The kernel module resolves its bundled runtime and returns it under `omowright`.
  const { omowright } = await loaded.loadOmowright();
  return omowright;
}
