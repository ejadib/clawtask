/** Conservative B1 contract: audited native OpenClaw 2026.10.5 / 2026.10.8 semantics only.
 * Version is a semantic allowlist, never proof that a particular row has the
 * required fields. Runtime preparation must independently verify all readbacks.
 * Do not infer backend admission CAS from protocol 4 or method names alone.
 */
export function verifyRuntimeContract(hello: any): void {
  const server=hello?.server;
  // Minimum baseline is .5, not an open-ended >= promise. See the source audit
  // and rollout/legacy gates in docs/runtime-gateway-rollout.md before expanding.
  if (!['2026.10.5', '2026.10.8'].includes(server?.version) ||
      (server.buildId !== undefined && (typeof server.buildId !== 'string' || !server.buildId.trim() || server.buildId.length > 96)) ||
      !Array.isArray(hello.features?.methods) ||
      !['sessions.create','sessions.describe','sessions.patch','agent'].every(method=>hello.features.methods.includes(method))) {
    throw new Error('runtime_contract_unsupported');
  }
}
