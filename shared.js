// Shared helpers used by the service worker, the page widget and the popup.
// Loaded as a plain script everywhere (no modules), so it hangs one object off globalThis.
(function () {
  if (globalThis.SS) return;

  // Everything the extension stores lives under these keys in chrome.storage.local.
  const KEYS = ['timer', 'settings', 'grass', 'stats', 'ui', 'lastEvent'];

  const DEFAULT_SETTINGS = {
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    longEvery: 4,
    autoStart: false,
    notifications: true,
    hiddenHosts: [],
  };

  const LIMITS = {
    focusMin: [1, 180],
    shortMin: [1, 60],
    longMin: [1, 90],
    longEvery: [2, 12],
  };

  const PHASE_LABEL = { focus: 'Focus', short: 'Short break', long: 'Long break' };

  function clampInt(value, range, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(range[1], Math.max(range[0], n));
  }

  function cleanSettings(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    Object.keys(LIMITS).forEach(function (k) {
      s[k] = clampInt(s[k], LIMITS[k], DEFAULT_SETTINGS[k]);
    });
    s.autoStart = !!s.autoStart;
    s.notifications = !!s.notifications;
    s.hiddenHosts = Array.isArray(s.hiddenHosts)
      ? s.hiddenHosts.filter(function (h) { return typeof h === 'string'; })
      : [];
    return s;
  }

  function phaseMs(settings, phase) {
    const min = phase === 'long' ? settings.longMin : phase === 'short' ? settings.shortMin : settings.focusMin;
    return min * 60 * 1000;
  }

  // A timer that is not running. `endsAt` only has a value while status is "running".
  function idleTimer(settings, phase) {
    const d = phaseMs(settings, phase);
    return { phase: phase, status: 'idle', durationMs: d, remainingMs: d, endsAt: null, finished: false };
  }

  // Fill in anything missing so every caller can rely on the full shape.
  function withDefaults(raw) {
    raw = raw || {};
    const settings = cleanSettings(raw.settings);
    return {
      settings: settings,
      timer: Object.assign(idleTimer(settings, 'focus'), raw.timer || {}),
      grass: Number.isFinite(raw.grass) ? raw.grass : 0,
      stats: Object.assign({ dayKey: '', today: 0, total: 0, sinceLong: 0 }, raw.stats || {}),
      ui: Object.assign({ fx: 0, fy: 1, minimized: false }, raw.ui || {}),
      lastEvent: raw.lastEvent || null,
    };
  }

  function remaining(timer, now) {
    return timer.status === 'running' ? Math.max(0, timer.endsAt - now) : timer.remainingMs;
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // Which pose the sheep should strike for this timer.
  function spriteState(timer) {
    if (timer.status === 'running') return timer.phase === 'focus' ? 'studying' : 'sleeping';
    if (timer.status === 'paused' && timer.phase === 'focus') return 'paused';
    return 'sleeping';
  }

  // Turn the origins Chrome reports as granted into plain http/https match patterns.
  // Anything that is not a web page (file://, chrome://) is dropped on purpose.
  function webMatches(origins) {
    const out = [];
    (origins || []).forEach(function (o) {
      const list = o === '<all_urls>' || o === '*://*/*' ? ['http://*/*', 'https://*/*'] : /^(https?|\*):\/\//.test(o) ? [o] : [];
      list.forEach(function (m) { if (out.indexOf(m) === -1) out.push(m); });
    });
    return out;
  }

  function hasAllSites(matches) {
    return matches.indexOf('http://*/*') !== -1 && matches.indexOf('https://*/*') !== -1;
  }

  // "https://news.site.com/*" -> "news.site.com"
  function hostOfMatch(match) {
    const m = /^[^:]+:\/\/([^/]+)\//.exec(match);
    return m ? m[1] : match;
  }

  function dayKey(d) {
    d = d || new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  // ---------------------------------------------------------------------------
  // The sheep. One SVG, four poses, switched with a data-state attribute:
  // studying | sleeping | paused | celebrating
  // ---------------------------------------------------------------------------

  function circles(list) {
    return list
      .map(function (c) { return '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + c[2] + '"/>'; })
      .join('');
  }

  // Draw a cloud shape: a fat outline layer first, then the fill on top, so the
  // circles merge into one fluffy outline instead of showing seams.
  function cloud(list, fill, line, width) {
    return (
      '<g fill="' + line + '" stroke="' + line + '" stroke-width="' + width + '">' + circles(list) + '</g>' +
      '<g fill="' + fill + '">' + circles(list) + '</g>'
    );
  }

  const WOOL = [[80, 34, 18], [58, 40, 18], [102, 40, 18], [44, 58, 17], [116, 58, 17], [54, 78, 17], [106, 78, 17], [80, 82, 19], [80, 58, 30]];
  const TUFT = [[73, 44, 7.5], [87, 44, 7.5], [80, 41, 8.5]];
  const MINI_WOOL = [[24, 12, 8.5], [14.5, 16, 8], [33.5, 16, 8], [9.5, 28, 7.5], [38.5, 28, 7.5], [15, 37, 6.5], [33, 37, 6.5], [24, 26, 13]];
  const MINI_TUFT = [[20, 17, 4.6], [28, 17, 4.6], [24, 15, 5.2]];
  const CONFETTI_COLORS = ['#f08a5d', '#f9d56e', '#8fc7a1', '#7fb3e0', '#e79bc2'];

  function confetti() {
    let out = '<g class="confetti">';
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const dist = 42 + (i % 3) * 10;
      const dx = Math.round(Math.cos(a) * dist);
      const dy = Math.round(Math.sin(a) * dist - 16);
      const rot = (i % 2 ? 1 : -1) * (120 + i * 17);
      const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      out +=
        '<g transform="translate(80 34)"><rect class="c" x="-2.4" y="-1.6" width="4.8" height="3.2" rx="1" ' +
        'style="--dx:' + dx + 'px;--dy:' + dy + 'px;--rot:' + rot + 'deg;--c:' + color + ';animation-delay:' + (i % 4) * 0.06 + 's"/></g>';
    }
    return out + '</g>';
  }

  function sheepSvg() {
    return (
      '<svg class="ss-sheep" viewBox="0 0 160 124" data-state="sleeping" aria-hidden="true" focusable="false">' +
        '<ellipse class="shadow" cx="80" cy="117" rx="50" ry="5" fill="#3c321e" fill-opacity=".14"/>' +
        '<g class="pillow"><ellipse cx="80" cy="111" rx="52" ry="10" fill="#cfe0ee" stroke="#a9c3d8" stroke-width="2"/></g>' +
        '<g class="body-g">' +
          '<g class="wool">' + cloud(WOOL, '#fffdf6', '#d8caa8', 5) + '</g>' +
          '<g class="head">' +
            '<ellipse cx="57" cy="58" rx="11" ry="6" transform="rotate(-20 57 58)" fill="#4d4139"/>' +
            '<ellipse cx="103" cy="58" rx="11" ry="6" transform="rotate(20 103 58)" fill="#4d4139"/>' +
            '<ellipse cx="55" cy="58" rx="5" ry="2.6" transform="rotate(-20 55 58)" fill="#e9a79f"/>' +
            '<ellipse cx="105" cy="58" rx="5" ry="2.6" transform="rotate(20 105 58)" fill="#e9a79f"/>' +
            '<ellipse cx="80" cy="60" rx="17" ry="19" fill="#4d4139"/>' +
            '<g class="tuft">' + cloud(TUFT, '#fffdf6', '#d8caa8', 3) + '</g>' +
            '<g class="eyes-open">' +
              '<circle cx="72.5" cy="61" r="4.4" fill="#fffdf6"/><circle class="pupil" cx="72.5" cy="61" r="2.4" fill="#2b231d"/>' +
              '<circle cx="87.5" cy="61" r="4.4" fill="#fffdf6"/><circle class="pupil" cx="87.5" cy="61" r="2.4" fill="#2b231d"/>' +
            '</g>' +
            '<g class="eyes-closed" fill="none" stroke="#f5e9d0" stroke-width="2" stroke-linecap="round">' +
              '<path d="M67.8 61.5q4.7 4 9.4 0"/><path d="M82.8 61.5q4.7 4 9.4 0"/>' +
            '</g>' +
            '<g class="eyes-happy" fill="none" stroke="#f5e9d0" stroke-width="2.2" stroke-linecap="round">' +
              '<path d="M67.8 63q4.7-5.4 9.4 0"/><path d="M82.8 63q4.7-5.4 9.4 0"/>' +
            '</g>' +
            '<circle cx="65" cy="70" r="3.4" fill="#f3a5a0" fill-opacity=".55"/>' +
            '<circle cx="95" cy="70" r="3.4" fill="#f3a5a0" fill-opacity=".55"/>' +
            '<ellipse cx="80" cy="67.5" rx="3" ry="2.2" fill="#f0b4ae"/>' +
            '<path class="mouth-closed" d="M76 72q4 3.6 8 0" fill="none" stroke="#f0b4ae" stroke-width="1.8" stroke-linecap="round"/>' +
            '<path class="mouth-open" d="M75.5 71.5q4.5 6.4 9 0z" fill="#e98d86"/>' +
          '</g>' +
        '</g>' +
        '<g class="desk">' +
          '<rect x="22" y="92" width="116" height="24" rx="7" fill="#cf9f6e" stroke="#a97a4c" stroke-width="2"/>' +
          '<rect x="24" y="94" width="112" height="6" rx="3" fill="#dcb283"/>' +
          '<path d="M80 88L47 83V97L80 102Z" fill="#fffdf5" stroke="#cdbf9f" stroke-width="1.6" stroke-linejoin="round"/>' +
          '<path d="M80 88L113 83V97L80 102Z" fill="#fffdf5" stroke="#cdbf9f" stroke-width="1.6" stroke-linejoin="round"/>' +
          '<path d="M53 88.4L74 91.6M53 93L74 96.2M107 88.4L86 91.6M107 93L86 96.2" stroke="#ddd3bb" stroke-width="1.4" stroke-linecap="round"/>' +
          '<ellipse cx="64" cy="87" rx="6.5" ry="4.6" fill="#4d4139"/>' +
          '<ellipse class="hoof-r" cx="96" cy="87" rx="6.5" ry="4.6" fill="#4d4139"/>' +
        '</g>' +
        '<g class="zzz" font-family="ui-rounded,system-ui,sans-serif" font-weight="800" fill="#7f9fbd">' +
          '<text x="104" y="38" font-size="13">z</text><text x="114" y="26" font-size="10.5">z</text><text x="122" y="15" font-size="8.5">z</text>' +
        '</g>' +
        confetti() +
      '</svg>'
    );
  }

  // Small round face used when the widget is minimized.
  function miniSvg() {
    return (
      '<svg class="ss-mini" viewBox="0 0 48 48" data-state="sleeping" aria-hidden="true" focusable="false">' +
        cloud(MINI_WOOL, '#fffdf6', '#d8caa8', 3) +
        '<ellipse cx="13" cy="28" rx="6" ry="3.4" transform="rotate(-22 13 28)" fill="#4d4139"/>' +
        '<ellipse cx="35" cy="28" rx="6" ry="3.4" transform="rotate(22 35 28)" fill="#4d4139"/>' +
        '<ellipse cx="24" cy="29" rx="9.5" ry="11" fill="#4d4139"/>' +
        cloud(MINI_TUFT, '#fffdf6', '#d8caa8', 2) +
        '<g class="m-open"><circle cx="20" cy="29.5" r="2.6" fill="#fffdf6"/><circle cx="20" cy="30.2" r="1.4" fill="#2b231d"/>' +
        '<circle cx="28" cy="29.5" r="2.6" fill="#fffdf6"/><circle cx="28" cy="30.2" r="1.4" fill="#2b231d"/></g>' +
        '<g class="m-closed" fill="none" stroke="#f5e9d0" stroke-width="1.4" stroke-linecap="round"><path d="M17.8 30q2.2 2.2 4.4 0"/><path d="M25.8 30q2.2 2.2 4.4 0"/></g>' +
        '<g class="m-happy" fill="none" stroke="#f5e9d0" stroke-width="1.5" stroke-linecap="round"><path d="M17.8 31q2.2-2.8 4.4 0"/><path d="M25.8 31q2.2-2.8 4.4 0"/></g>' +
        '<circle cx="16" cy="34" r="1.9" fill="#f3a5a0" fill-opacity=".55"/><circle cx="32" cy="34" r="1.9" fill="#f3a5a0" fill-opacity=".55"/>' +
        '<ellipse cx="24" cy="33.4" rx="1.8" ry="1.3" fill="#f0b4ae"/>' +
      '</svg>'
    );
  }

  const sheepCss = [
    '.ss-sheep{display:block;overflow:visible}',
    '.ss-sheep .desk,.ss-sheep .zzz,.ss-sheep .pillow,.ss-sheep .confetti,.ss-sheep .eyes-open,.ss-sheep .eyes-closed,.ss-sheep .eyes-happy,.ss-sheep .mouth-open{display:none}',
    '.ss-sheep[data-state="studying"] .desk,.ss-sheep[data-state="paused"] .desk,',
    '.ss-sheep[data-state="studying"] .eyes-open,.ss-sheep[data-state="paused"] .eyes-open,',
    '.ss-sheep[data-state="sleeping"] .eyes-closed,.ss-sheep[data-state="sleeping"] .pillow,.ss-sheep[data-state="sleeping"] .zzz,',
    '.ss-sheep[data-state="celebrating"] .eyes-happy,.ss-sheep[data-state="celebrating"] .mouth-open,.ss-sheep[data-state="celebrating"] .confetti{display:inline}',
    '.ss-sheep[data-state="celebrating"] .mouth-closed{display:none}',
    '.ss-sheep .head{transform-origin:80px 70px}',
    '.ss-sheep .body-g{transform-origin:80px 104px}',
    '.ss-sheep[data-state="studying"] .head{transform:translateY(3px);animation:ss-bob 2.6s ease-in-out infinite}',
    '.ss-sheep[data-state="studying"] .pupil{transform:translateY(1.4px)}',
    '.ss-sheep[data-state="studying"] .eyes-open,.ss-sheep[data-state="paused"] .eyes-open{transform-box:fill-box;transform-origin:center;animation:ss-blink 5s infinite}',
    '.ss-sheep[data-state="studying"] .hoof-r{animation:ss-write 1.1s ease-in-out infinite}',
    '.ss-sheep[data-state="sleeping"] .body-g{transform:translateY(12px);animation:ss-breathe 3.6s ease-in-out infinite}',
    '.ss-sheep[data-state="sleeping"] .head{transform:rotate(10deg) translateY(2px)}',
    '.ss-sheep[data-state="celebrating"] .body-g{animation:ss-jump .6s ease-in-out 5}',
    '.ss-sheep[data-state="celebrating"] .shadow{transform-box:fill-box;transform-origin:center;animation:ss-shadow .6s ease-in-out 5}',
    '.ss-sheep .zzz text{opacity:0;animation:ss-z 3.2s ease-in-out infinite}',
    '.ss-sheep .zzz text:nth-child(2){animation-delay:1s}',
    '.ss-sheep .zzz text:nth-child(3){animation-delay:2s}',
    // The confetti must only start moving when the celebration starts, not when the widget is built.
    '.ss-sheep .confetti .c{fill:var(--c);opacity:0}',
    '.ss-sheep[data-state="celebrating"] .confetti .c{animation:ss-confetti 1.3s ease-out 2 both}',
    '@keyframes ss-bob{0%,100%{transform:translateY(3px)}50%{transform:translateY(4.6px)}}',
    '@keyframes ss-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}',
    '@keyframes ss-write{0%,100%{transform:translateX(0)}50%{transform:translateX(3px)}}',
    '@keyframes ss-breathe{0%,100%{transform:translateY(12px) scale(1)}50%{transform:translateY(12px) scale(1.025,1.04)}}',
    '@keyframes ss-jump{0%,100%{transform:translateY(8px)}45%{transform:translateY(-8px) scale(.98,1.03)}}',
    '@keyframes ss-shadow{0%,100%{transform:scale(1)}45%{transform:scale(.8)}}',
    '@keyframes ss-z{0%{opacity:0;transform:translate(0,4px)}30%{opacity:1}100%{opacity:0;transform:translate(7px,-12px)}}',
    '@keyframes ss-confetti{0%{opacity:1;transform:translate(0,0) rotate(0)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(var(--rot))}}',
    '.ss-mini{display:block}',
    '.ss-mini .m-open,.ss-mini .m-closed,.ss-mini .m-happy{display:none}',
    '.ss-mini[data-state="studying"] .m-open,.ss-mini[data-state="paused"] .m-open,.ss-mini[data-state="sleeping"] .m-closed,.ss-mini[data-state="celebrating"] .m-happy{display:inline}',
    '@media (prefers-reduced-motion:reduce){.ss-sheep *{animation:none!important}.ss-sheep .confetti{display:none!important}.ss-sheep .zzz text{opacity:1}}',
  ].join('');

  globalThis.SS = {
    KEYS: KEYS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    LIMITS: LIMITS,
    PHASE_LABEL: PHASE_LABEL,
    cleanSettings: cleanSettings,
    phaseMs: phaseMs,
    idleTimer: idleTimer,
    withDefaults: withDefaults,
    remaining: remaining,
    formatTime: formatTime,
    spriteState: spriteState,
    dayKey: dayKey,
    webMatches: webMatches,
    hasAllSites: hasAllSites,
    hostOfMatch: hostOfMatch,
    sheepSvg: sheepSvg,
    miniSvg: miniSvg,
    sheepCss: sheepCss,
  };
})();
