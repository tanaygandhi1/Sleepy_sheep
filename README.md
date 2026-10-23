# Sleepy Sheep (Chrome extension)

A cozy focus timer. A little sheep studies with you while the timer runs, and naps when you're on a break. It sits in the bottom-left of any tab. Drag it wherever you like.

Version 0.1.0. Plain JavaScript, Manifest V3, no build step.

## Install (Load unpacked)

1. Unzip the folder somewhere permanent, like `Documents/sleepy-sheep`. Chrome reads the files from that folder every time, so don't delete or move it later.
2. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `sleepy-sheep` folder (the one that has `manifest.json` directly inside).
5. A welcome page opens. Click **Show on all websites (recommended)** and accept Chrome's prompt.
6. Click the puzzle-piece icon in the toolbar and pin Sleepy Sheep, so the minutes left show on the icon.

Chrome may show a "Disable developer mode extensions" popup on Windows at startup. That's normal for unpacked extensions. Just dismiss it.

## Using it

- Click the sheep to start or pause. Click the small buttons for reset (tap twice while running) and minimize.
- Drag the sheep anywhere. Drop it near a corner and it snaps there.
- Click the toolbar icon for settings: focus/break lengths, long break, which sites the sheep appears on, and hiding it on the current site.
- A finished focus session gives 10 grass, +5 for the first one of the day. Skipping a break gives nothing.

## Changing the code

After editing any file, go to `chrome://extensions` and press the reload arrow on the Sleepy Sheep card. Then refresh any open tabs.

## How it's built

- `background.js`: service worker. Owns the timer (stored as an end timestamp, so it stays right even when the worker sleeps), alarms, badge, notifications and script registration.
- `content.js`: the floating sheep, in a Shadow DOM so page styles can't break it.
- `shared.js`: settings, timer helpers and the sheep SVG, used by every part.
- `popup.*`: the toolbar popup. `welcome.*`: the first-run page.
- Permissions: the extension only asks for website access when you click Allow. Nothing leaves your browser; all data is in `chrome.storage.local`.

## Next steps

1. Put the code on GitHub with a release zip (works as the "download" for a portfolio).
2. Submit to Microsoft Edge Add-ons (free) for a real store listing and auto-updates.
3. Chrome Web Store later, once the $5 fee is possible.
4. Shop with paid skins, soundscapes, streaks.
