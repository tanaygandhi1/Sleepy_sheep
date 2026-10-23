// Toolbar popup: shows the same timer as the page widget, holds the settings,
// and is where the user chooses which websites the sheep may appear on.
(function () {
  'use strict';

  const SS = globalThis.SS;
  const $ = function (id) { return document.getElementById(id); };
  const ALL_SITES = ['http://*/*', 'https://*/*'];

  let raw = {};
  let state = SS.withDefaults({});
  let page = null; // { host, protocol } of the active tab, when it is a normal web page
  let site = { all: false, covered: false }; // what we last learned about site access

  const numberFields = ['focusMin', 'shortMin', 'longMin', 'longEvery'];
  const checkFields = ['autoStart', 'notifications'];

  function send(action, payload) {
    chrome.runtime.sendMessage({ type: 'cmd', action: action, payload: payload }).catch(function () {});
  }

  function render() {
    const t = state.timer;
    const running = t.status === 'running';

    $('phase').textContent = SS.PHASE_LABEL[t.phase] + (t.status === 'paused' ? ' (paused)' : '');
    $('toggle').textContent = running ? 'Pause' : t.status === 'paused' ? 'Resume' : 'Start';
    $('skip').hidden = t.phase === 'focus';
    $('grass').textContent = String(state.grass);

    const n = state.stats.dayKey === SS.dayKey() ? state.stats.today : 0;
    $('stats').textContent = n + (n === 1 ? ' session' : ' sessions') + ' today';

    $('sheep').firstElementChild.dataset.state = SS.spriteState(t);

    numberFields.forEach(function (k) {
      const input = $(k);
      if (document.activeElement !== input) input.value = state.settings[k];
    });
    checkFields.forEach(function (k) { $(k).checked = state.settings[k]; });

    renderHostRow();
    tick();
  }

  function tick() {
    $('time').textContent = SS.formatTime(SS.remaining(state.timer, Date.now()));
  }

  // --------------------------------------------------------------------------
  // Site access
  // --------------------------------------------------------------------------

  function button(text, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (className) b.className = className;
    b.addEventListener('click', onClick);
    return b;
  }

  // Chrome shows its own permission prompt. That prompt can close this popup, which is
  // fine: the service worker listens for the grant and adds the sheep to open tabs.
  function allow(origins) {
    chrome.permissions.request({ origins: origins }).then(refreshSites, refreshSites);
  }

  function revoke(origins) {
    chrome.permissions.remove({ origins: origins }).then(refreshSites, refreshSites);
  }

  async function findPage() {
    page = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const u = new URL(tabs[0].url); // readable because clicking the icon grants "activeTab"
      if (u.protocol === 'http:' || u.protocol === 'https:') page = { host: u.hostname, protocol: u.protocol };
    } catch (e) {
      page = null;
    }
  }

  async function refreshSites() {
    await findPage();
    const perms = await chrome.permissions.getAll();
    const matches = SS.webMatches(perms.origins);
    const all = SS.hasAllSites(matches);
    let covered = all;
    if (!all && page) {
      try {
        covered = await chrome.permissions.contains({ origins: [page.protocol + '//' + page.host + '/*'] });
      } catch (e) {
        covered = false;
      }
    }
    site = { all: all, covered: covered };

    const actions = $('sitesActions');
    const list = $('sitesList');
    actions.replaceChildren();
    list.replaceChildren();

    if (all) {
      $('sitesStatus').textContent = 'The sheep can show up on every website.';
      actions.appendChild(button('Turn off everywhere', '', function () { revoke(ALL_SITES); }));
    } else {
      $('sitesStatus').textContent = matches.length
        ? 'The sheep shows up on these sites only:'
        : 'The sheep is not showing anywhere yet. Choose where it may appear.';
      actions.appendChild(button('Allow all websites (recommended)', 'primary', function () { allow(ALL_SITES); }));
      if (page && !covered) {
        const host = page.host;
        actions.appendChild(button('Only ' + host, '', function () {
          allow(['http://' + host + '/*', 'https://' + host + '/*']);
        }));
      }

      // One row per site, even if both the http and https versions were allowed.
      const byHost = {};
      matches.forEach(function (m) {
        const h = SS.hostOfMatch(m);
        (byHost[h] = byHost[h] || []).push(m);
      });
      Object.keys(byHost).forEach(function (h) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = h;
        li.appendChild(name);
        li.appendChild(button('Remove', 'link', function () { revoke(byHost[h]); }));
        list.appendChild(li);
      });
    }

    renderHostRow();
  }

  function renderHostRow() {
    const row = $('hostRow');
    const note = $('hostNote');
    if (!page) {
      row.hidden = true;
      note.hidden = false;
      note.textContent = "The sheep can't appear on this page: Chrome keeps extensions out of its own pages (chrome://, the Web Store). The toolbar badge still shows the time.";
      return;
    }
    note.hidden = true;
    row.hidden = !site.covered;
    $('hostName').textContent = page.host;
    $('showHere').checked = state.settings.hiddenHosts.indexOf(page.host) === -1;
  }

  // --------------------------------------------------------------------------

  function wire() {
    $('toggle').addEventListener('click', function () { send('toggle'); });
    $('reset').addEventListener('click', function () { send('reset'); });
    $('skip').addEventListener('click', function () { send('skip'); });

    numberFields.forEach(function (k) {
      const input = $(k);
      input.addEventListener('change', function () {
        // Clamp locally so the box shows the value that will actually be used.
        const clean = SS.cleanSettings(Object.assign({}, state.settings, { [k]: input.value }))[k];
        input.value = clean;
        const patch = {};
        patch[k] = clean;
        send('settings', patch);
      });
    });

    checkFields.forEach(function (k) {
      $(k).addEventListener('change', function () {
        const patch = {};
        patch[k] = $(k).checked;
        send('settings', patch);
      });
    });

    $('showHere').addEventListener('change', function () {
      if (!page) return;
      send('setHostHidden', { host: page.host, hidden: !$('showHere').checked });
    });
  }

  async function init() {
    const style = document.createElement('style');
    style.textContent = SS.sheepCss;
    document.head.appendChild(style);
    $('sheep').innerHTML = SS.sheepSvg();

    raw = await chrome.storage.local.get(SS.KEYS);
    state = SS.withDefaults(raw);
    wire();
    render();
    refreshSites();

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      Object.keys(changes).forEach(function (k) {
        if (SS.KEYS.indexOf(k) !== -1) raw[k] = changes[k].newValue;
      });
      state = SS.withDefaults(raw);
      render();
    });

    chrome.permissions.onAdded.addListener(refreshSites);
    chrome.permissions.onRemoved.addListener(refreshSites);

    setInterval(tick, 500);
  }

  init();
})();
