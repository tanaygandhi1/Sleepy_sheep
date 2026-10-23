// Service worker: the single owner of the timer.
// Tabs and the popup only draw what is in storage and send commands here.
importScripts('shared.js');

const S = globalThis.SS;

// If the browser was closed or asleep when a session ended, we only count it when we
// wake up close to the real end time. Otherwise it would be free grass for nothing.
const GRACE_MS = 2 * 60 * 1000;
const REWARD = { base: 10, firstOfDay: 5 };
const BADGE = { focus: '#5e9b4f', rest: '#4f86b3', paused: '#c28a2c' };

// Run storage changes one at a time so two quick clicks can't overwrite each other.
let queue = Promise.resolve();
function locked(fn) {
  const p = queue.then(fn);
  queue = p.catch(function () {});
  return p;
}

async function load() {
  return S.withDefaults(await chrome.storage.local.get(S.KEYS));
}

// ---------------------------------------------------------------------------
// Timer transitions (pure helpers)
// ---------------------------------------------------------------------------

function startTimer(t, settings, now) {
  if (t.status === 'running') return t;
  const fresh = t.status === 'idle';
  const ms = fresh ? S.phaseMs(settings, t.phase) : t.remainingMs;
  return Object.assign({}, t, {
    status: 'running',
    durationMs: fresh ? ms : t.durationMs,
    remainingMs: ms,
    endsAt: now + ms,
    finished: false,
  });
}

function pauseTimer(t, now) {
  if (t.status !== 'running') return t;
  return Object.assign({}, t, {
    status: 'paused',
    remainingMs: Math.max(1000, t.endsAt - now),
    endsAt: null,
  });
}

// ---------------------------------------------------------------------------
// Alarms and badge
// ---------------------------------------------------------------------------

async function syncAlarms(t) {
  await chrome.alarms.clear('phase-end');
  await chrome.alarms.clear('badge');
  if (t.status !== 'running') return;
  chrome.alarms.create('phase-end', { when: t.endsAt });
  const msLeft = t.endsAt - Date.now();
  if (msLeft > 60000) {
    // Tick right when the "minutes left" number changes, then every minute.
    const k = Math.ceil(msLeft / 60000) - 1;
    chrome.alarms.create('badge', { when: t.endsAt - k * 60000, periodInMinutes: 1 });
  }
}

async function updateBadge(t) {
  let text = '';
  let color = BADGE.focus;
  if (t.status === 'running') {
    text = String(Math.max(1, Math.ceil((t.endsAt - Date.now()) / 60000)));
    color = t.phase === 'focus' ? BADGE.focus : BADGE.rest;
  } else if (t.status === 'paused') {
    text = 'II';
    color = BADGE.paused;
  } else if (t.finished) {
    text = 'OK';
    color = BADGE.focus;
  }
  try {
    await chrome.action.setBadgeText({ text: text });
    await chrome.action.setBadgeBackgroundColor({ color: color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  } catch (e) {
    // Badge is a nice-to-have; never let it break the timer.
  }
}

async function notifyDone(done, earned, next, settings) {
  if (!settings.notifications) return;
  try {
    // If a Chrome window is in front, the sheep on the page already celebrates.
    const w = await chrome.windows.getLastFocused();
    if (w && w.focused) return;
  } catch (e) {}
  const focusDone = done === 'focus';
  try {
    await chrome.notifications.create('ss-' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: focusDone ? 'Focus session done!' : 'Break is over',
      message: focusDone
        ? '+' + earned + ' grass. Time for a ' + (next === 'long' ? 'long ' : '') + 'break.'
        : 'Your sheep is ready to study again.',
      priority: 0,
    });
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Finishing a phase
// ---------------------------------------------------------------------------

async function completeIfDue() {
  const s = await load();
  const t = s.timer;
  const now = Date.now();
  if (t.status !== 'running' || !t.endsAt || t.endsAt > now) return false;

  const fresh = now - t.endsAt <= GRACE_MS;
  const done = t.phase;
  const stats = Object.assign({}, s.stats);
  let grass = s.grass;
  let earned = 0;
  let nextPhase = 'focus';

  const today = S.dayKey();
  if (stats.dayKey !== today) {
    stats.dayKey = today;
    stats.today = 0;
  }

  if (done === 'focus' && fresh) {
    earned = REWARD.base + (stats.today === 0 ? REWARD.firstOfDay : 0);
    grass += earned;
    stats.today += 1;
    stats.total += 1;
    stats.sinceLong += 1;
    if (stats.sinceLong >= s.settings.longEvery) {
      nextPhase = 'long';
      stats.sinceLong = 0;
    } else {
      nextPhase = 'short';
    }
  }

  let timer = Object.assign(S.idleTimer(s.settings, nextPhase), { finished: fresh });
  if (fresh && s.settings.autoStart) timer = startTimer(timer, s.settings, now);

  const patch = { timer: timer, grass: grass, stats: stats };
  if (fresh) patch.lastEvent = { id: now, type: 'complete', phase: done, grassEarned: earned, at: now };

  await chrome.storage.local.set(patch);
  await syncAlarms(timer);
  await updateBadge(timer);
  if (fresh) await notifyDone(done, earned, nextPhase, s.settings);
  return true;
}

async function reconcile() {
  await completeIfDue();
  const s = await load();
  await syncAlarms(s.timer);
  await updateBadge(s.timer);
}

// ---------------------------------------------------------------------------
// Commands from the widget and the popup
// ---------------------------------------------------------------------------

async function handleCommand(action, payload) {
  await completeIfDue();
  const now = Date.now();
  const s = await load();
  const settings = s.settings;
  let timer = s.timer;
  const patch = {};

  switch (action) {
    case 'start':
      timer = startTimer(timer, settings, now);
      break;
    case 'pause':
      timer = pauseTimer(timer, now);
      break;
    case 'toggle':
      timer = timer.status === 'running' ? pauseTimer(timer, now) : startTimer(timer, settings, now);
      break;
    case 'reset':
      timer = S.idleTimer(settings, timer.phase);
      break;
    case 'skip':
      // Only breaks can be skipped. A skipped focus session would be a free session.
      if (timer.phase !== 'focus') timer = S.idleTimer(settings, 'focus');
      break;
    case 'settings': {
      const merged = S.cleanSettings(Object.assign({}, settings, payload || {}));
      patch.settings = merged;
      if (timer.status === 'idle') {
        timer = Object.assign(S.idleTimer(merged, timer.phase), { finished: timer.finished });
      }
      break;
    }
    case 'setHostHidden': {
      const host = payload && payload.host;
      if (typeof host === 'string' && host) {
        const set = new Set(settings.hiddenHosts);
        if (payload.hidden) set.add(host);
        else set.delete(host);
        patch.settings = Object.assign({}, settings, { hiddenHosts: Array.from(set) });
      }
      break;
    }
    case 'tick':
      // A tab noticed 00:00 and is nudging us. completeIfDue above already handled it.
      break;
    default:
      return;
  }

  patch.timer = timer;
  await chrome.storage.local.set(patch);
  await syncAlarms(timer);
  await updateBadge(timer);
}

// ---------------------------------------------------------------------------
// Where the sheep is allowed to show up
// The user grants site access at runtime ("all sites" or one site at a time).
// We register the widget script only for what was granted.
// ---------------------------------------------------------------------------

const SCRIPT_ID = 'sleepy-sheep-widget';
const WIDGET_FILES = ['shared.js', 'content.js'];

async function grantedMatches() {
  const perms = await chrome.permissions.getAll();
  return S.webMatches(perms.origins);
}

async function syncContentScripts() {
  const matches = await grantedMatches();
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch (e) {
    // Nothing registered yet.
  }
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    { id: SCRIPT_ID, matches: matches, js: WIDGET_FILES, runAt: 'document_idle', persistAcrossSessions: true },
  ]);
}

// Registered scripts only affect pages loaded from now on. Tabs that are already open
// need the widget pushed in, or the user would have to reload every tab by hand.
async function injectIntoOpenTabs() {
  const matches = await grantedMatches();
  if (!matches.length) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: matches });
  } catch (e) {
    return;
  }
  await Promise.all(
    tabs.map(async function (tab) {
      if (tab.id == null || tab.discarded) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: WIDGET_FILES });
      } catch (e) {
        // Pages Chrome keeps off limits (Web Store, error pages) simply refuse.
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Wiring (listeners must be registered synchronously at the top level)
// ---------------------------------------------------------------------------

// The permission prompt can close the toolbar popup before it hears the answer,
// so the worker is the one that reacts to a grant.
chrome.permissions.onAdded.addListener(function () {
  locked(async function () {
    await syncContentScripts();
    await injectIntoOpenTabs();
  });
});

chrome.permissions.onRemoved.addListener(function () {
  locked(syncContentScripts);
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'cmd') return;
  locked(function () { return handleCommand(msg.action, msg.payload); })
    .then(function () { sendResponse({ ok: true }); })
    .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
  return true; // keep the channel open for the async response
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'phase-end') {
    locked(completeIfDue);
  } else if (alarm.name === 'badge') {
    locked(async function () {
      const s = await load();
      await updateBadge(s.timer);
    });
  }
});

chrome.runtime.onInstalled.addListener(function (details) {
  locked(async function () {
    // Write defaults only for keys that don't exist yet, so updates never wipe grass.
    const raw = await chrome.storage.local.get(S.KEYS);
    const defaults = S.withDefaults(raw);
    const patch = {};
    S.KEYS.forEach(function (k) {
      if (raw[k] === undefined && defaults[k] !== null) patch[k] = defaults[k];
    });
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    await reconcile();
    await syncContentScripts();
    // After an update or a reload during development, swap the old widgets for the new code.
    if (details.reason !== 'install') await injectIntoOpenTabs();
  });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

chrome.runtime.onStartup.addListener(function () {
  locked(async function () {
    await reconcile();
    await syncContentScripts();
  });
});

// The worker also wakes up for messages and alarms. Make sure nothing is stale.
locked(reconcile);
