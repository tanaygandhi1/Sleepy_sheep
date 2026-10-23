// The floating sheep + timer that lives on every page.
// It never runs the timer itself: it reads the end time from storage, draws the
// countdown, and sends button presses to the service worker.
(function () {
  'use strict';

  if (window.__sleepySheepLoaded) return;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  window.__sleepySheepLoaded = true;

  const SS = globalThis.SS;
  const MARGIN = 20; // gap kept between the widget and the window edge
  const SNAP_DISTANCE = 110; // how close to a corner a drop must be to snap into it
  const CELEBRATE_MS = 3000;

  const ICON = {
    play: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M4.5 2.5v11l9-5.5z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><rect x="3.5" y="2.5" width="3.6" height="11" rx="1.2"/><rect x="8.9" y="2.5" width="3.6" height="11" rx="1.2"/></svg>',
    reset: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.7-3.8"/><path d="M13.2 2.4v3.3H9.9"/></svg>',
    minimize: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
    leaf: '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2.5 13.5C2.5 7 6.5 2.5 13.5 2.5 13.5 9 9.5 13.5 2.5 13.5z"/></svg>',
  };

  const CSS = `
    :host { all: initial; }
    .wrap {
      display: flex; flex-direction: column; align-items: center; width: 172px;
      font-family: ui-rounded, "SF Pro Rounded", Nunito, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #3b372f; user-select: none; -webkit-user-select: none; touch-action: none;
    }
    .wrap[data-mini="true"] { width: 46px; }
    .wrap[data-mini="true"] .full { display: none; }
    .wrap[data-mini="false"] .mini { display: none; }
    .full { display: flex; flex-direction: column; align-items: center; width: 100%; }
    .pill {
      width: 100%; box-sizing: border-box; padding: 6px 9px 5px 11px;
      background: #fff8ea; border: 2px solid #e4d6b8; border-radius: 18px;
      box-shadow: 0 4px 14px rgba(60, 50, 30, .22);
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .time { font-size: 23px; font-weight: 800; letter-spacing: .5px; line-height: 1.15; font-variant-numeric: tabular-nums; cursor: grab; }
    .wrap.dragging .time, .wrap.dragging .sheepbox, .wrap.dragging .mini { cursor: grabbing; }
    .btns { display: flex; gap: 4px; }
    .ib {
      all: unset; box-sizing: border-box; width: 22px; height: 22px; border-radius: 50%;
      display: grid; place-items: center; cursor: pointer; background: #efe2c4; color: #4a4337;
    }
    .ib:hover { background: #e6d3a8; }
    .ib:focus-visible, .sheepbox:focus-visible, .mini:focus-visible { outline: 2px solid #5e9b4f; outline-offset: 2px; }
    .ib.armed { background: #f3c9b8; color: #8a3a1c; }
    .meta { display: flex; justify-content: space-between; align-items: center; margin-top: 2px; font-size: 10.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #8a7d62; }
    .phase { display: inline-flex; align-items: center; gap: 5px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #c9bd9f; }
    .wrap[data-run="focus"] .dot { background: #5e9b4f; }
    .wrap[data-run="rest"] .dot { background: #4f86b3; }
    .wrap[data-run="paused"] .dot { background: #c28a2c; }
    .grass { display: inline-flex; align-items: center; gap: 3px; color: #4a7f3d; }
    .sheepbox { position: relative; width: 128px; margin-top: 3px; cursor: pointer; border-radius: 12px; }
    .sheepbox svg { width: 100%; height: auto; }
    .toast {
      position: absolute; left: 50%; top: 4px; transform: translateX(-50%); opacity: 0; pointer-events: none;
      white-space: nowrap; padding: 3px 9px; font-size: 12px; font-weight: 800; color: #4a7f3d;
      background: #fff8ea; border: 2px solid #e4d6b8; border-radius: 12px;
    }
    .toast.show { animation: toast 2.4s ease-out both; }
    @keyframes toast {
      0% { opacity: 0; transform: translate(-50%, 6px); }
      12% { opacity: 1; transform: translate(-50%, 0); }
      80% { opacity: 1; transform: translate(-50%, 0); }
      100% { opacity: 0; transform: translate(-50%, -10px); }
    }
    .mini {
      position: relative; box-sizing: border-box; width: 46px; height: 46px; padding: 3px; border-radius: 50%;
      background: #fff8ea; border: 2px solid #e4d6b8; box-shadow: 0 4px 14px rgba(60, 50, 30, .22); cursor: pointer;
    }
    .mini svg { width: 100%; height: 100%; }
    .status { position: absolute; right: -2px; bottom: -2px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff8ea; background: transparent; }
    .wrap[data-run="focus"] .status { background: #5e9b4f; }
    .wrap[data-run="rest"] .status { background: #4f86b3; }
    .wrap[data-run="paused"] .status { background: #c28a2c; }
    @media (prefers-reduced-motion: reduce) { .toast.show { animation: none; opacity: 1; } }
  `;

  // Raw copy of what is in storage; `state` is the same thing with defaults filled in.
  let raw = {};
  let state = SS.withDefaults({});

  let host = null;
  let shadow = null;
  let el = {};
  let tickHandle = null;
  let nudged = false; // asked the service worker to finish the phase once
  let celebrating = false;
  let celebrateTimer = null;
  let pendingEvent = null;
  let seenEventId = null;
  let resetArmedUntil = 0;
  let resetTimer = null;
  let drag = null;
  let posQueued = false;
  let keeper = null;

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

  function alive() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
  }

  function isHidden() {
    return state.settings.hiddenHosts.indexOf(location.hostname) !== -1;
  }

  function send(action, payload) {
    if (!alive()) return destroy();
    try {
      const p = chrome.runtime.sendMessage({ type: 'cmd', action: action, payload: payload });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {
      destroy();
    }
  }

  function saveUI(patch) {
    if (!alive()) return destroy();
    state.ui = Object.assign({}, state.ui, patch);
    try {
      const p = chrome.storage.local.set({ ui: state.ui });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {
      destroy();
    }
  }

  // --------------------------------------------------------------------------
  // Building the widget
  // --------------------------------------------------------------------------

  function build() {
    if (host) return;
    // A copy left behind by an older version of the extension (e.g. after "Reload" on
    // chrome://extensions) can't talk to us any more. Clear it so there is only one sheep.
    document.querySelectorAll('sleepy-sheep-widget').forEach(function (old) { old.remove(); });
    host = document.createElement('sleepy-sheep-widget');
    host.setAttribute(
      'style',
      'all:initial;position:fixed;left:0;top:0;z-index:2147483647;display:block;visibility:hidden;'
    );
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      '<style>' + SS.sheepCss + CSS + '</style>' +
      '<div class="wrap" data-mini="false" data-run="idle">' +
        '<div class="full">' +
          '<div class="pill">' +
            '<div class="row">' +
              '<div class="time" id="time">25:00</div>' +
              '<div class="btns">' +
                '<button class="ib" id="play" type="button"></button>' +
                '<button class="ib" id="reset" type="button" aria-label="Reset" title="Reset">' + ICON.reset + '</button>' +
                '<button class="ib" id="min" type="button" aria-label="Minimize" title="Minimize">' + ICON.minimize + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="meta">' +
              '<span class="phase"><i class="dot"></i><span id="phase">Focus</span></span>' +
              '<span class="grass" title="Grass">' + ICON.leaf + '<span id="grass">0</span></span>' +
            '</div>' +
          '</div>' +
          '<div class="sheepbox" id="sheep" role="button" tabindex="0">' + SS.sheepSvg() + '<div class="toast" id="toast"></div></div>' +
        '</div>' +
        '<div class="mini" id="mini" role="button" tabindex="0" aria-label="Show Sleepy Sheep" title="Show Sleepy Sheep">' +
          SS.miniSvg() + '<i class="status"></i>' +
        '</div>' +
      '</div>';

    const q = function (sel) { return shadow.querySelector(sel); };
    el = {
      wrap: q('.wrap'),
      time: q('#time'),
      play: q('#play'),
      reset: q('#reset'),
      min: q('#min'),
      phase: q('#phase'),
      grass: q('#grass'),
      sheepBox: q('#sheep'),
      sheep: q('.ss-sheep'),
      mini: q('#mini'),
      miniSvg: q('.ss-mini'),
      toast: q('#toast'),
    };

    el.play.addEventListener('click', function () { send('toggle'); });
    el.reset.addEventListener('click', onReset);
    el.min.addEventListener('click', function () { saveUI({ minimized: true }); render(); });

    // The sheep and the minimized face react to pointer-up so a click and a drag can be told apart.
    shadow.addEventListener('pointerdown', onPointerDown);
    shadow.addEventListener('pointermove', onPointerMove);
    shadow.addEventListener('pointerup', onPointerUp);
    shadow.addEventListener('pointercancel', onPointerCancel);
    [el.sheepBox, el.mini].forEach(function (node) {
      node.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(node);
        }
      });
    });

    document.documentElement.appendChild(host);

    // Some pages rebuild <html>. If our widget gets knocked out, put it back.
    keeper = new MutationObserver(function () {
      if (host && !host.isConnected && alive()) document.documentElement.appendChild(host);
    });
    keeper.observe(document.documentElement, { childList: true });
  }

  function activate(node) {
    if (node === el.mini) {
      saveUI({ minimized: false });
      render();
    } else {
      send('toggle');
    }
  }

  function onReset() {
    const now = Date.now();
    if (state.timer.status === 'running' && now > resetArmedUntil) {
      // A running session is worth protecting: ask for a second tap.
      resetArmedUntil = now + 2200;
      el.reset.classList.add('armed');
      showToast('Tap reset again to confirm');
      clearTimeout(resetTimer);
      resetTimer = setTimeout(disarmReset, 2300);
      return;
    }
    disarmReset();
    send('reset');
  }

  function disarmReset() {
    resetArmedUntil = 0;
    if (el.reset) el.reset.classList.remove('armed');
  }

  // --------------------------------------------------------------------------
  // Dragging
  // --------------------------------------------------------------------------

  function viewport() {
    const de = document.documentElement;
    let w = de.clientWidth;
    let h = de.clientHeight;
    if (!w || !h || document.compatMode === 'BackCompat') {
      w = window.innerWidth;
      h = window.innerHeight;
    }
    return { w: w, h: h };
  }

  // Position is stored as a fraction (0 to 1) of the free space, so it still makes
  // sense after a resize and on screens of different sizes.
  function applyPos() {
    if (!host) return;
    const vp = viewport();
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    const ax = Math.max(0, vp.w - w - 2 * MARGIN);
    const ay = Math.max(0, vp.h - h - 2 * MARGIN);
    host.style.left = Math.round(MARGIN + state.ui.fx * ax) + 'px';
    host.style.top = Math.round(MARGIN + state.ui.fy * ay) + 'px';
    host.style.visibility = 'visible';
  }

  function schedulePos() {
    if (posQueued) return;
    posQueued = true;
    requestAnimationFrame(function () {
      posQueued = false;
      applyPos();
    });
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('.ib')) return; // real buttons handle their own clicks
    const r = host.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, left: r.left, top: r.top, moved: false, target: e.target };
    try { el.wrap.setPointerCapture(e.pointerId); } catch (err) {}
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      host.style.transition = 'none';
      el.wrap.classList.add('dragging');
    }
    const vp = viewport();
    const left = Math.min(Math.max(0, drag.left + dx), Math.max(0, vp.w - host.offsetWidth));
    const top = Math.min(Math.max(0, drag.top + dy), Math.max(0, vp.h - host.offsetHeight));
    host.style.left = left + 'px';
    host.style.top = top + 'px';
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    try { el.wrap.releasePointerCapture(e.pointerId); } catch (err) {}
    el.wrap.classList.remove('dragging');
    if (d.moved) {
      finishDrag();
    } else if (d.target.closest) {
      if (d.target.closest('#sheep')) activate(el.sheepBox);
      else if (d.target.closest('#mini')) activate(el.mini);
    }
  }

  function onPointerCancel() {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    el.wrap.classList.remove('dragging');
    if (moved) finishDrag();
  }

  function finishDrag() {
    const vp = viewport();
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    const ax = Math.max(0, vp.w - w - 2 * MARGIN);
    const ay = Math.max(0, vp.h - h - 2 * MARGIN);
    const left = parseFloat(host.style.left) || 0;
    const top = parseFloat(host.style.top) || 0;
    let fx = ax > 0 ? (left - MARGIN) / ax : 0;
    let fy = ay > 0 ? (top - MARGIN) / ay : 0;
    fx = Math.min(1, Math.max(0, fx));
    fy = Math.min(1, Math.max(0, fy));

    // Snap into the nearest corner if the drop was close to one.
    let best = null;
    [0, 1].forEach(function (cx) {
      [0, 1].forEach(function (cy) {
        const dist = Math.hypot(left - (MARGIN + cx * ax), top - (MARGIN + cy * ay));
        if (dist < SNAP_DISTANCE && (!best || dist < best.dist)) best = { cx: cx, cy: cy, dist: dist };
      });
    });
    if (best) {
      fx = best.cx;
      fy = best.cy;
    }

    host.style.transition = 'left .18s ease, top .18s ease';
    saveUI({ fx: fx, fy: fy });
    applyPos();
  }

  // --------------------------------------------------------------------------
  // Drawing the current state
  // --------------------------------------------------------------------------

  function render() {
    if (!alive()) return destroy();
    if (isHidden()) {
      if (host) host.style.display = 'none';
      stopTicking();
      return;
    }
    build();
    host.style.display = 'block';

    const t = state.timer;
    const mini = !!state.ui.minimized;
    const running = t.status === 'running';
    const sprite = celebrating ? 'celebrating' : SS.spriteState(t);
    const run = running ? (t.phase === 'focus' ? 'focus' : 'rest') : t.status === 'paused' ? 'paused' : 'idle';

    el.wrap.dataset.mini = String(mini);
    el.wrap.dataset.run = run;
    el.sheep.dataset.state = sprite;
    el.miniSvg.dataset.state = sprite;

    const label = running ? 'Pause' : t.status === 'paused' ? 'Resume' : 'Start';
    el.play.innerHTML = running ? ICON.pause : ICON.play;
    el.play.setAttribute('aria-label', label);
    el.play.title = label;
    el.sheepBox.setAttribute('aria-label', label + ' ' + SS.PHASE_LABEL[t.phase].toLowerCase());

    el.phase.textContent = SS.PHASE_LABEL[t.phase] + (t.status === 'paused' ? ' (paused)' : '');
    el.grass.textContent = String(state.grass);

    if (t.status !== 'running') nudged = false;
    updateTicking();
    applyPos();
  }

  function tick() {
    if (!alive()) return destroy();
    const t = state.timer;
    const left = SS.remaining(t, Date.now());
    const text = SS.formatTime(left);
    if (el.time && el.time.textContent !== text) el.time.textContent = text;
    if (t.status === 'running' && left <= 0 && !nudged) {
      nudged = true;
      send('tick'); // make sure the phase is finished even if the alarm is late
    }
  }

  function stopTicking() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = null;
  }

  // Only run the 500ms ticker while a session is running and the tab is actually visible.
  function updateTicking() {
    const should = state.timer.status === 'running' && document.visibilityState === 'visible' && !isHidden();
    if (should && !tickHandle) tickHandle = setInterval(tick, 500);
    else if (!should) stopTicking();
    tick();
  }

  function showToast(text) {
    if (!el.toast) return;
    el.toast.textContent = text;
    el.toast.classList.remove('show');
    void el.toast.offsetWidth; // restart the animation
    el.toast.classList.add('show');
  }

  // --------------------------------------------------------------------------
  // Celebrations
  // --------------------------------------------------------------------------

  function onEvent(ev) {
    if (!ev || ev.id === seenEventId) return;
    seenEventId = ev.id;
    pendingEvent = ev;
    maybeCelebrate();
  }

  function maybeCelebrate() {
    if (!pendingEvent || !host || isHidden()) return;
    if (document.visibilityState !== 'visible') return; // wait until the tab is looked at
    const ev = pendingEvent;
    pendingEvent = null;
    if (Date.now() - ev.at > 60000) return; // too old to be worth cheering for
    if (ev.phase === 'focus') {
      celebrating = true;
      clearTimeout(celebrateTimer);
      celebrateTimer = setTimeout(function () {
        celebrating = false;
        if (host) render();
      }, CELEBRATE_MS);
      render();
      showToast('+' + ev.grassEarned + ' grass');
    } else {
      showToast("Break's over");
    }
  }

  // --------------------------------------------------------------------------
  // Staying in sync
  // --------------------------------------------------------------------------

  function destroy() {
    stopTicking();
    clearTimeout(celebrateTimer);
    clearTimeout(resetTimer);
    if (keeper) keeper.disconnect();
    keeper = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    window.removeEventListener('resize', schedulePos);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  function onVisibility() {
    if (!host) return;
    maybeCelebrate();
    updateTicking();
  }

  function init() {
    chrome.storage.local.get(SS.KEYS).then(function (data) {
      raw = data || {};
      state = SS.withDefaults(raw);
      seenEventId = state.lastEvent ? state.lastEvent.id : null; // don't cheer for old news
      render();
    }).catch(function () {});

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !alive()) return;
      let touched = false;
      Object.keys(changes).forEach(function (k) {
        if (SS.KEYS.indexOf(k) !== -1) {
          raw[k] = changes[k].newValue;
          touched = true;
        }
      });
      if (!touched) return;
      state = SS.withDefaults(raw);
      if (changes.lastEvent) onEvent(changes.lastEvent.newValue);
      render();
    });

    // The popup asks which site this tab is on so it can offer "hide on this site".
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.type === 'getHost') sendResponse({ host: location.hostname });
    });

    window.addEventListener('resize', schedulePos);
    document.addEventListener('visibilitychange', onVisibility);
  }

  init();
})();
