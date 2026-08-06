import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  MAX_RELOADS_IN_WINDOW,
  RECOVERY_WINDOW_MS,
  RELOAD_DELAY_MS,
  isRecoverableRendererGoneReason,
  createRendererGoneGuard,
} = require('../electron/renderer-gone.js');

function makeHarness(overrides = {}) {
  let nowValue = 0;
  const timers = [];
  const reloaded = [];
  const window = overrides.window || {
    isDestroyed: () => false,
    reload: () => reloaded.push('reload'),
  };
  const guard = createRendererGoneGuard({
    window,
    now: () => nowValue,
    scheduleReload: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearReload: () => {},
    reloadWindow: (target) => reloaded.push(target),
    ...overrides,
  });
  return {
    guard,
    timers,
    reloaded,
    window,
    setNow: (value) => {
      nowValue = value;
    },
    fire: () => {
      // fire the latest scheduled reload callback synchronously
      const fn = timers.pop();
      if (fn) fn();
    },
  };
}

test('only transient crash reasons are auto-recoverable', () => {
  for (const reason of ['crashed', 'oom', 'abnormal-exit']) {
    assert.equal(isRecoverableRendererGoneReason(reason), true, `expected ${reason} recoverable`);
  }
  for (const reason of ['clean-exit', 'killed', 'launch-failed', 'integrity-failure', 'unknown', undefined]) {
    assert.equal(isRecoverableRendererGoneReason(reason), false, `expected ${reason} unrecoverable`);
  }
});

test('unrecoverable reasons never schedule a reload', () => {
  const { guard, timers } = makeHarness();
  const outcome = guard.onRenderProcessGone('launch-failed');
  assert.deepEqual(outcome, { recovered: false, reason: 'unrecoverable' });
  assert.equal(timers.length, 0);
});

test('a recoverable reason schedules exactly one bounded reload', () => {
  const { guard, timers, reloaded, fire } = makeHarness();
  const outcome = guard.onRenderProcessGone('crashed');
  assert.deepEqual(outcome, { recovered: true, reason: 'scheduled' });
  assert.equal(timers.length, 1);
  fire();
  assert.equal(reloaded.length, 1);
});

test('retry budget is bounded within the recovery window', () => {
  const { guard, timers, reloaded, fire, setNow } = makeHarness();
  // Two recoverable crashes inside the window -> both reload.
  for (let i = 0; i < MAX_RELOADS_IN_WINDOW; i++) {
    setNow(i * 1000);
    const outcome = guard.onRenderProcessGone('oom');
    assert.equal(outcome.recovered, true, `attempt ${i + 1} should be scheduled`);
    fire();
  }
  assert.equal(reloaded.length, MAX_RELOADS_IN_WINDOW);
  // Third crash within the window -> budget exhausted, no more reloads.
  setNow(MAX_RELOADS_IN_WINDOW * 1000);
  const exhausted = guard.onRenderProcessGone('oom');
  assert.deepEqual(exhausted, { recovered: false, reason: 'retries-exhausted' });
  fire();
  assert.equal(reloaded.length, MAX_RELOADS_IN_WINDOW);
});

test('retry budget resets after did-finish-load (reset)', () => {
  const { guard, timers, reloaded, fire, setNow } = makeHarness();
  for (let i = 0; i < MAX_RELOADS_IN_WINDOW; i++) {
    guard.onRenderProcessGone('crashed');
    fire();
  }
  assert.equal(reloaded.length, MAX_RELOADS_IN_WINDOW);
  guard.reset();
  setNow(MAX_RELOADS_IN_WINDOW * 1000);
  const afterReset = guard.onRenderProcessGone('crashed');
  assert.equal(afterReset.recovered, true);
});

test('reload never fires for a window that was destroyed (window replaced)', () => {
  let destroyed = false;
  const capturedWindow = {
    isDestroyed: () => destroyed,
    reload: () => {},
  };
  const { guard, timers, reloaded, fire } = makeHarness({ window: capturedWindow });
  guard.onRenderProcessGone('crashed');
  assert.equal(timers.length, 1);
  // The captured window is closed/destroyed before the delayed reload fires.
  destroyed = true;
  fire();
  assert.equal(timers.length, 0);
  // A destroyed window is never reloaded (the replacement window is untouched).
  assert.equal(reloaded.length, 0);
});

test('recovery window constants are sane', () => {
  assert.equal(MAX_RELOADS_IN_WINDOW, 2);
  assert.equal(RECOVERY_WINDOW_MS, 30_000);
  assert.equal(RELOAD_DELAY_MS, 1_500);
});
