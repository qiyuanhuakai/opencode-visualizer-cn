// Task 27 browser entry — case-owned `app/backends/registry` stub.
//
// app/composables/useDesktopBridgeVersion.ts imports exactly one symbol from
// `../backends/registry` (`kimiWebBridgeHttpUrl`), but that barrel also pulls the
// entire backend-adapter graph (OpenCode/Codex/ACP/Kimi/DSH clients, storage-key
// migration). The QA surface must stay hermetic and small, so
// scripts/qa/runtime-v090-cases/task-27.mjs aliases the registry specifier onto THIS
// module. The stub reproduces the ONE function the composable calls
// (ws/wss -> http/https); the LOGIC under test — the host-identity- vs URL-locality
// decision — is the real composable code.
export function kimiWebBridgeHttpUrl(bridgeUrl) {
  const parsed = new URL(bridgeUrl);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else throw new Error(`Unsupported Kimi Web bridge URL protocol: ${parsed.protocol}`);
  return parsed.toString();
}

export default { kimiWebBridgeHttpUrl };
