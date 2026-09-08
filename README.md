# NFL BEANO

Version 24.2.0 is the static game-night edition. It runs directly from GitHub Pages while retaining the corrected square rules and feed processing developed for the future server edition.

## 1. Current game-night scope

- One host selects an NFL game and creates a four-character room.
- Friends join from their browsers with the room code; no account or database is required.
- The host processes every unseen ESPN play rather than only the newest play.
- Cards contain 16 common, 6 uncommon, and 2 rare events, plus the free center in applicable modes.
- All selected cards render, and rerolls close after the first official event.
- The host can call or revoke an event if the feed misses or misclassifies a play.
- Feed health and replay games are available for pre-game checks.

## 2. GitHub Pages deployment

The site has no build step. In the GitHub repository:

1. Open **Settings**, then **Pages**.
2. Under **Build and deployment**, select **Deploy from a branch**.
3. Select the `main` branch and the `/ (root)` folder.
4. Save and wait for GitHub to publish the site.

The `.nojekyll` marker keeps GitHub Pages from applying Jekyll processing. Relative asset paths work when the repository is published below `github.io/nfl-bingo/`.

## 3. Local verification

The game can be served by any static web server. For example:

```powershell
npx --yes serve .
```

Open the printed local URL in two browser windows, host a replay game in one, join from the other, and verify the room, calls, cards, and winner state stay synchronized.

Rule tests require Node.js 22.5 or newer and no third-party packages:

```powershell
npm test
```

## 4. Temporary service boundaries

This friends-only edition uses ESPN's browser feed and the public EMQX MQTT relay. Neither is an application service controlled by this project. The room relay is unauthenticated, four-character room codes are not private, and service availability is not guaranteed. Do not use this edition for accounts, private data, prizes, or public competitive play.

The ESPN adapter is also temporary while a licensed live-data provider is evaluated. It should not be treated as a documented or supported production API.

## 5. Preserved server edition

The `server-version` branch contains version 24.1.0 with the Node/WebSocket room service, host tokens, in-memory room validation, Docker packaging, and nginx example. That branch is the staging base for a future Vultr deployment and eventual login/database work.
