'use strict';

// Reasons that represent a transient renderer crash worth one bounded retry
// window. Unrecoverable reasons (launch-failed, integrity-failure, killed,
// clean-exit) must never trigger an auto-reload loop.
const RECOVERABLE_REASONS = new Set(['crashed', 'oom', 'abnormal-exit']);

// Stop auto-recovering after MAX_RELOADS_IN_WINDOW reloads within a rolling
// RECOVERY_WINDOW_MS window. A successful did-finish-load resets the budget.
const MAX_RELOADS_IN_WINDOW = 2;
const RECOVERY_WINDOW_MS = 30_000;
const RELOAD_DELAY_MS = 1_500;

function isRecoverableRendererGoneReason(reason) {
  return RECOVERABLE_REASONS.has(reason);
}

// Bounded auto-recovery guard for the renderer process. Pure logic with all
// side effects injectable so it can be unit-tested without Electron.
function createRendererGoneGuard(options = {}) {
  const now = options.now || (() => Date.now());
  const scheduleReload = options.scheduleReload || ((fn, delay) => setTimeout(fn, delay));
  const clearReload = options.clearReload || ((timer) => clearTimeout(timer));
  const reloadWindow = options.reloadWindow || ((win) => win.reload());
  const log = options.log || (() => {});

  let windowRef = options.window || null;
  let reloadTimestamps = [];
  let pendingTimer = null;

  function reset() {
    reloadTimestamps = [];
  }

  function onRenderProcessGone(reason) {
    if (!isRecoverableRendererGoneReason(reason)) {
      log(`renderer gone reason is not auto-recoverable: ${reason}`);
      return { recovered: false, reason: 'unrecoverable' };
    }

    const timestamp = now();
    reloadTimestamps = reloadTimestamps.filter((ts) => timestamp - ts < RECOVERY_WINDOW_MS);
    if (reloadTimestamps.length >= MAX_RELOADS_IN_WINDOW) {
      log('renderer retry budget exhausted within recovery window');
      return { recovered: false, reason: 'retries-exhausted' };
    }

    const target = windowRef;
    if (pendingTimer !== null) clearReload(pendingTimer);
    pendingTimer = scheduleReload(() => {
      pendingTimer = null;
      // Only touch the window instance captured at schedule time; if it was
      // destroyed and a new window was created, do not reload the replacement.
      if (target && !target.isDestroyed()) {
        reloadTimestamps.push(now());
        reloadWindow(target);
      }
    }, RELOAD_DELAY_MS);
    return { recovered: true, reason: 'scheduled' };
  }

  return { onRenderProcessGone, reset };
}

module.exports = {
  RECOVERABLE_REASONS,
  MAX_RELOADS_IN_WINDOW,
  RECOVERY_WINDOW_MS,
  RELOAD_DELAY_MS,
  isRecoverableRendererGoneReason,
  createRendererGoneGuard,
};
