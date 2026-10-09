import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentRunControl, stripAgentRunControl } from '../src/lib/agent-run-control';

test('defaults a completed agent run to done when no directive is present', () => {
  assert.deepEqual(parseAgentRunControl('Draft created.'), { status: 'done', unassign: false });
});

test('accepts a verified-run directive to return a task to todo and unassign', () => {
  const output = 'Draft created.\nCLAWTASK_FINAL: {"status":"todo","unassign":true}';
  assert.deepEqual(parseAgentRunControl(output), { status: 'todo', unassign: true });
  assert.equal(stripAgentRunControl(output), 'Draft created.');
});

test('rejects malformed or unsupported directives', () => {
  assert.deepEqual(parseAgentRunControl('CLAWTASK_FINAL: {"status":"archived"}'), { status: 'done', unassign: false });
  assert.deepEqual(parseAgentRunControl('CLAWTASK_FINAL: not-json'), { status: 'done', unassign: false });
});
