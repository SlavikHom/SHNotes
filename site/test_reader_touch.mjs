import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPDFTouchGestures,installPDFWheelZoom} from './reader-touch.mjs';

function setup(kind = 'touch') {
  const container = new EventTarget(), frames = new Map();
  let id = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const calls = [], pans = [];
  const viewer = {
    pdfDocument: {}, currentScale: .5,
    container: {clientHeight: 800, getBoundingClientRect: () => ({left: 20, right: 420, top: 100, bottom: 900})},
    updateScale(options) { calls.push(options); this.currentScale = Math.round(this.currentScale * options.scaleFactor * 100) / 100; },
    panBy(x, y) { pans.push([x, y]); },
  };
  const reset = (kind === 'wheel' ? installPDFWheelZoom : installPDFTouchGestures)(container, () => viewer);
  const touch = (x, y, identifier = 0) => ({clientX: x, clientY: y, identifier});
  const event = (type, touches = []) => {
    const event = new Event(type, {cancelable: true});
    event.touches = touches;
    container.dispatchEvent(event);
    return event;
  };
  const tick = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback()); };
  const wheel = (deltaY, options = {}) => {
    const event = new Event('wheel', {cancelable: true});
    Object.assign(event, {deltaY, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 170, clientY: 320}, options);
    container.dispatchEvent(event);
    return event;
  };
  return {viewer, calls, pans, touch, event, wheel, tick, reset, frames};
}

test('one-finger swipes keep native scrolling and inertia', () => {
  const {event, touch, calls} = setup();
  assert.equal(event('touchstart', [touch(100, 300)]).defaultPrevented, false);
  assert.equal(event('touchmove', [touch(100, 100)]).defaultPrevented, false);
  event('touchend');
  assert.equal(calls.length, 0);
});

test('pinch enlarges only the PDF and pans around the fingers', () => {
  const {event, touch, tick, viewer, calls} = setup();
  assert.equal(event('touchstart', [touch(100, 200), touch(200, 200, 1)]).defaultPrevented, true);
  assert.equal(event('touchmove', [touch(70, 210), touch(270, 210, 1)]).defaultPrevented, true);
  tick();
  assert.equal(viewer.currentScale, 1);
  assert.deepEqual(calls[0].origin, [150, 200]);
  assert.deepEqual(calls[0].pan, [20, 10]);
  assert.equal(calls[0].drawingDelay, 200);
});

test('moves in one frame coalesce, preserving the absolute gesture scale', () => {
  const {event, touch, tick, viewer, calls} = setup();
  event('touchstart', [touch(0, 200), touch(100, 200, 1)]);
  event('touchmove', [touch(0, 200), touch(120, 200, 1)]);
  event('touchmove', [touch(0, 200), touch(150, 200, 1)]);
  tick();
  assert.equal(calls.length, 1);
  assert.equal(viewer.currentScale, .75);
  event('touchmove', [touch(0, 200), touch(200, 200, 1)]);
  tick();
  assert.equal(viewer.currentScale, 1);
});

test('lifting one finger flushes the final scale and allows continued panning', () => {
  const {event, touch, viewer, pans, calls} = setup();
  event('touchstart', [touch(0, 200), touch(100, 200, 1)]);
  event('touchmove', [touch(0, 200), touch(200, 200, 1)]);
  event('touchend', [touch(0, 200)]);
  assert.equal(viewer.currentScale, 1);
  assert.equal(calls.length, 1);
  assert.equal(event('touchmove', [touch(10, 100)]).defaultPrevented, true);
  assert.deepEqual(pans, [[10, -100]]);
  event('touchend');
  event('touchstart', [touch(20, 200)]);
  assert.equal(event('touchmove', [touch(20, 100)]).defaultPrevented, false);
});

test('zoom is bounded and cancellation/document switches discard queued work', () => {
  const {event, touch, tick, viewer, calls, reset, frames} = setup();
  event('touchstart', [touch(0, 200), touch(100, 200, 1)]);
  event('touchmove', [touch(0, 200), touch(1000, 200, 1)]);
  tick();
  assert.equal(viewer.currentScale, 4);
  event('touchmove', [touch(0, 200), touch(1, 200, 1)]);
  tick();
  assert.equal(viewer.currentScale, .1);
  event('touchmove', [touch(0, 200), touch(200, 200, 1)]);
  event('touchcancel');
  assert.equal(frames.size, 0);
  tick();
  assert.equal(calls.length, 2);
  event('touchstart', [touch(0, 200), touch(100, 200, 1)]);
  event('touchmove', [touch(0, 200), touch(200, 200, 1)]);
  reset();
  tick();
  assert.equal(calls.length, 2);
});

test('Safari native gesture events are cancelled only while a PDF is open', () => {
  const {event, viewer} = setup();
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    assert.equal(event(type).defaultPrevented, true);
  }
  viewer.pdfDocument = null;
  assert.equal(event('gesturestart').defaultPrevented, false);
  assert.equal(event('touchstart', [{clientX: 0, clientY: 0}, {clientX: 100, clientY: 0}]).defaultPrevented, false);
});

test('Ctrl+wheel zooms the PDF at the cursor and suppresses browser zoom', () => {
  const {wheel, tick, viewer, calls} = setup('wheel');
  assert.equal(wheel(-100, {ctrlKey: true}).defaultPrevented, true);
  tick();
  assert.ok(viewer.currentScale > .5);
  assert.deepEqual(calls[0].origin, [170, 320]);
  const enlarged = viewer.currentScale;
  assert.equal(wheel(100, {ctrlKey: true}).defaultPrevented, true);
  tick();
  assert.ok(viewer.currentScale < enlarged);
});

test('normal wheel scrolling and browser zoom without a PDF are unaffected', () => {
  const {wheel, tick, viewer, calls} = setup('wheel');
  assert.equal(wheel(100).defaultPrevented, false);
  viewer.pdfDocument = null;
  assert.equal(wheel(-100, {ctrlKey: true}).defaultPrevented, false);
  tick();
  assert.equal(calls.length, 0);
});

test('wheel units are normalized and zoom stays bounded over the toolbar', () => {
  const {wheel, tick, viewer, calls} = setup('wheel');
  wheel(-3, {metaKey: true, deltaMode: 1, clientY: 20});
  tick();
  assert.ok(viewer.currentScale > .5);
  assert.deepEqual(calls[0].origin, [170, 100]);
  viewer.currentScale = 4;
  assert.equal(wheel(-1, {ctrlKey: true, deltaMode: 2}).defaultPrevented, true);
  tick();
  assert.equal(viewer.currentScale, 4);
  viewer.currentScale = .1;
  assert.equal(wheel(100, {ctrlKey: true}).defaultPrevented, true);
  tick();
  assert.equal(viewer.currentScale, .1);
});

test('tiny trackpad deltas accumulate across frames without being rounded away', () => {
  const {wheel, tick, viewer} = setup('wheel');
  for (let i = 0; i < 100; i++) {
    wheel(-1, {ctrlKey: true});
    tick();
  }
  assert.ok(viewer.currentScale > .57);
});

test('wheel frames coalesce and a document switch discards queued zoom', () => {
  const {wheel, tick, calls, viewer, reset, frames} = setup('wheel');
  wheel(-100, {ctrlKey: true});
  wheel(-100, {ctrlKey: true});
  tick();
  assert.equal(calls.length, 1);
  assert.ok(viewer.currentScale > .65);
  wheel(-100, {ctrlKey: true});
  reset();
  assert.equal(frames.size, 0);
  tick();
  assert.equal(calls.length, 1);
});
