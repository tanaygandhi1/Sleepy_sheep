// First-run page: asks for site access in plain words, then gets out of the way.
(function () {
  'use strict';

  const SS = globalThis.SS;
  const $ = function (id) { return document.getElementById(id); };
  const ALL_SITES = ['http://*/*', 'https://*/*'];

  function say(text, warn) {
    const box = $('result');
    box.textContent = text;
    box.classList.toggle('warn', !!warn);
    box.hidden = false;
  }

  function init() {
    const style = document.createElement('style');
    style.textContent = SS.sheepCss;
    document.head.appendChild(style);
    $('sheep').innerHTML = SS.sheepSvg();
    $('sheep').firstElementChild.dataset.state = 'studying';

    // This must be called straight from the click, with nothing awaited before it.
    $('all').addEventListener('click', function () {
      chrome.permissions.request({ origins: ALL_SITES }).then(function (granted) {
        if (granted) {
          say('Done! Your sheep is now on the pages you have open. Tip: pin Sleepy Sheep from the puzzle-piece menu so the minutes left always show on the toolbar.');
        } else {
          say('No problem, nothing was changed. You can allow it later from the sheep icon in the toolbar.', true);
        }
      }, function () {
        say("Chrome didn't open the permission prompt. Try again, or use the sheep icon in the toolbar.", true);
      });
    });

    $('each').addEventListener('click', function () {
      say('Open a website you like, click the sheep icon in the toolbar, and choose "Only" with that site. Do it again for any other site you want.');
    });
  }

  init();
})();
