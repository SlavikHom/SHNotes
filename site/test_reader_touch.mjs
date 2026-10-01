import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPDFTouchGestures} from './reader-touch.mjs';

function setup() {
  const container = new EventTarget(), frames = new Map();
  let id = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const calls = [], pans = [];
  const viewer = {
    pdfDocument: {}, currentScale: .5,
    updateScale(options) { calls.push(options); this.currentScale = Math.round(this.currentScale * options.scaleFactor * 100) / 100; },
    panBy(x, y) { pans.push([x, y]); },
  };
  const reset = installPDFTouchGestures(container, () => viewer);
  const touch = (x, y, identifier = 0) => ({clientX: x, clientY: y, identifier});
  const event = (type, touches = []) => {
    const event = new Event(type, {cancelable: true});
    event.touches = touches;
    container.dispatchEvent(event);
    return event;
  };
  const tick = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback()); };
  return {viewer, calls, pans, touch, event, tick, reset, frames};
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
