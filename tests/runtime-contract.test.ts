import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRuntimeContract } from '../src/lib/runtime-contract';

const hello = (version: unknown = '2026.10.8') => ({
  server: { version, buildId: 'synthetic-build' },
  features: { methods: ['sessions.create', 'sessions.describe', 'sessions.patch', 'agent'] },
});
for (const version of ['2026.10.5', '2026.10.8']) {
  test('audited contract accepts exact release ' + version, () => {
    assert.doesNotThrow(() => verifyRuntimeContract(hello(version)));
    const noBuild: any = hello(version); delete noBuild.server.buildId;
    assert.doesNotThrow(() => verifyRuntimeContract(noBuild));
  });
  for (const method of hello().features.methods) test(version + ' rejects missing method ' + method, () => {
    const value = hello(version); value.features.methods = value.features.methods.filter(m => m !== method);
    assert.throws(() => verifyRuntimeContract(value), /runtime_contract_unsupported/);
  });
}
for (const version of ['2026.10.3', '2026.10.4', '2026.10.6', '2026.10.7', '2026.10.9',
  '2026.10.50', '2026.10.8-dev', '2026.10.8+custom', 'v2026.10.8', '', null, 8, {}, undefined]) {
  test('unqualified release never inherits minimum-version support: ' + String(version), () => {
    const value: any = hello(); value.server.version = version;
    assert.throws(() => verifyRuntimeContract(value), /runtime_contract_unsupported/);
  });
}
for (const buildId of ['', ' ', 8, null, 'x'.repeat(97)]) test('invalid build identity ' + String(buildId), () => {
  const value: any = hello(); value.server.buildId = buildId;
  assert.throws(() => verifyRuntimeContract(value), /runtime_contract_unsupported/);
});
for (const value of [null, {}, { server: { version: '2026.10.8' } }, { ...hello(), features: { methods: 'agent' } }]) {
  test('incomplete authenticated contract fails closed: ' + JSON.stringify(value), () => {
    assert.throws(() => verifyRuntimeContract(value), /runtime_contract_unsupported/);
  });
}
