import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrollToBottomKey } from './browser/scroll-to-bottom-key';

test('Darwin selects the native document-bottom chord', () => {
  assert.equal(scrollToBottomKey('darwin'), 'Meta+ArrowDown');
});

for (const platform of ['linux', 'win32', 'freebsd'] as const) {
  test(platform + ' preserves Control+End', () => {
    assert.equal(scrollToBottomKey(platform), 'Control+End');
  });
}

test('default selection uses the actual Node host, not an emulated browser', () => {
  assert.equal(scrollToBottomKey(), process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
});
