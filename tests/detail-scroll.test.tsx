import './dom-setup';
import React from 'react';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, render, fireEvent } from '@testing-library/react';
import { useDetailScroll } from '../src/hooks/useDetailScroll';

afterEach(cleanup);
function setup() {
  const calls: number[] = [];
  let controls: ReturnType<typeof useDetailScroll>;
  function Harness({ comments }: { comments: { id: string }[] }) {
    controls = useDetailScroll(comments);
    return <div ref={controls.contentRef} onScroll={controls.onScroll} />;
  }
  const ui = render(<Harness comments={[]} />);
  const node = ui.container.firstChild as HTMLDivElement;
  Object.defineProperties(node, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
  node.scrollTo = options => { calls.push((options as ScrollToOptions).top!); };
  return {
    calls,
    update(ids: string[]) { ui.rerender(<Harness comments={ids.map(id => ({ id }))} />); },
    position(top: number) { node.scrollTop = top; fireEvent.scroll(node); },
    jump() { act(() => controls!.jumpToLatest()); },
    sent() { controls!.followOwnSend.current = true; },
  };
}

test('initial nonempty timeline stays at the description', () => {
  const h = setup(); h.update(['a', 'b']); assert.deepEqual(h.calls, []);
});
test('incoming append follows only after the reader scrolls near the bottom', () => {
  const h = setup(); h.update(['a']); h.position(200); h.update(['a', 'b']);
  assert.deepEqual(h.calls, []);
  h.position(1450); h.update(['a', 'b', 'c']); assert.deepEqual(h.calls, [2000]);
});
test('same IDs (edits, dedup and reload) never follow, even at bottom', () => {
  const h = setup(); h.update(['a']); h.position(1500); h.update(['a']); h.update(['a']);
  assert.deepEqual(h.calls, []);
});
test('explicit jump scrolls only the referenced owner', () => {
  const h = setup(); h.jump(); assert.deepEqual(h.calls, [2000]);
});
test('successful own send follows even while reading, and consumes intent once', () => {
  const h = setup(); h.update(['a']); h.position(0); h.sent(); h.update(['a', 'mine']);
  assert.deepEqual(h.calls, [2000]); h.update(['a', 'mine']); assert.deepEqual(h.calls, [2000]);
});
