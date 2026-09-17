# ChannelSurfer

A desktop application for browsing and watching live TV streams with a rich, modern program guide.

## Contents

- [Screenshots](#screenshots)
- [Features](#features)
- [Installation](#installation)
- [Releases](#releases)
- [How It Works](#how-it-works)
- [Program Guide Accuracy](#program-guide-accuracy)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Build](#build)
- [Contributing](#contributing)
- [License](#license)
- [Credits](#credits)
- [Built With](#built-with)
- [Disclaimer](#disclaimer)

## Screenshots

### Program Guide

![](./documentation/Program-Guide.png)

### Single View

![](./documentation/Single-View-Mode.png)

### Dual View

![](./documentation/Dual-View-Mode.png)

### Grid View

![](./documentation/Grid-View-Mode.png)

## Features

### 📋 Program Guide

Browse current programming across all available stations.

- Click an empty panel to open the program guide
- The program guide shows program titles and descriptions (on hover)
- Drag the divider between the Channel and Program columns to resize them

### 🖥️ Multi-View Watching

Watch multiple channels at once.

- **Single View** — Watch one program
- **Dual View** — Watch two programs concurrently
- **Grid View** — Watch up to four programs concurrently
- Individual panels expand to fullscreen when the player's fullscreen button is clicked

Streams keep playing when you switch views: a panel you populated in Grid View is
still live when you return to it — no reconnect, no "Connecting..." message.
Panels in views you're not looking at continue playing silently in the background
(muted). Keep in mind that every live panel consumes network bandwidth, so a
populated Grid View running in the background still uses your connection.

### 🔄 Automatic Failover

The stream source occasionally changes the domains and URL paths it uses to serve content. When this happens, ChannelSurfer tries a list of known player URLs in order and uses the first one that plays. Recovery is automatic — no action needed from the user.

### 🛡️ Built-in Protection

ChannelSurfer blocks intrusive ads, trackers, and malicious domains, and prevents pages from opening pop-up windows.

### 🌙 Modern Dark Interface

Designed for comfortable viewing in low-light environments.

## Installation

### 🍎 macOS
1. Download `ChannelSurfer-universal.dmg` from the [latest release](../../releases/latest).
2. Open the DMG and drag `ChannelSurfer.app` into your **Applications** folder.
3. On first launch, macOS may warn that the app is from an unidentified developer. Right-click the app and select **Open**, then confirm.

### 🪟 Windows
1. Download `ChannelSurfer-win32-x64.zip` from the [latest release](../../releases/latest).
2. Extract the zip to a folder of your choice.
3. Double-click `ChannelSurfer.exe`.
4. On first launch, Windows SmartScreen may warn you. Click **More info** → **Run anyway**.

### 🐧 Linux
1. Download `ChannelSurfer-linux-x64.tar.gz` from the [latest release](../../releases/latest).
2. Extract:
   ```bash
   tar -xzf ChannelSurfer-linux-x64.tar.gz
   cd ChannelSurfer-linux-x64
   ```
3. Run:
   ```bash
   ./ChannelSurfer
   ```
   If the executable bit was lost during transfer, restore it with `chmod +x ChannelSurfer`.

## Releases

Pre-built binaries for macOS, Windows, and Linux will be available on the
[Releases page](https://github.com/channelsurfer-1/ChannelSurfer/releases) once the
first release is published.

Each release will include platform-specific download links and full release
notes describing what changed.

## How It Works

1. Launch the app
2. Click "Click to select a program" in any panel
3. Browse the program guide for the program that interests you
4. Click the program to fill that panel
5. Switch from Single to Dual or Grid View to view more than one program at a time — populated panels resume instantly, right where they left off
6. Closing a program returns the panel to the program guide

If the primary stream URL fails, the app automatically tries alternate
sources before giving up. A brief "Connecting..."
message appears in the panel during this process.

## Program Guide Accuracy

The program guide relies on publicly available EPG data.

It works well for national networks. Broadcast networks like CBS, ABC, NBC, and FOX may not always match the exact local feed used by the stream source.

Treat the schedule as a helpful guide rather than an authoritative source.

## Configuration

ChannelSurfer loads a small remote configuration file on startup. This allows
the list of trusted domains and the list of stream player URLs to be updated
without rebuilding or redistributing the app.

**Config location:**

```
https://gist.githubusercontent.com/channelsurfer-1/cf46021791c0140d8321675b2fcead7b/raw/config.json
```

**Fields:**

- `baseStreamUrls` — list of stream player URL prefixes, tried in order.
  The channel ID is appended directly, followed by `.php`. For example,
  the prefix `https://dlive.sx/stream/stream-` becomes
  `https://dlive.sx/stream/stream-51.php` for channel 51.
- `safeDomains` — list of domains the app is permitted to contact.
  All other network requests are blocked.

**Loading order:**

1. Remote config (the gist above)
2. Local cache (`userData/config.json`, written whenever the remote loads successfully)
3. Hardcoded baseline in `main.js` — a minimal fallback containing only the
   core stream-site domains, used only if both the remote fetch and the cache
   fail (e.g. first launch while offline). It exists to guarantee the app
   always starts in a valid state.

If the remote fetch fails, the app falls back to the cache. If the cache is
empty, it falls back to the baseline. The app continues to start in all cases.

**How to update:**

1. Edit the gist.
2. Restart the app.

No rebuild, no re-release, no waiting for users to update.

**When to update:**

- If a stream stops playing, check the terminal output for `[BLOCK]` lines
  (see below). If a blocked domain looks like stream infrastructure rather
  than an ad or tracker, add it to `safeDomains`.
- If the app cannot connect to any candidate URL, inspect the stream source's
  current player URL in a browser and add or update `baseStreamUrls` accordingly.

A reference copy of the config file is kept in the repository at
`documentation/config.example.json`.

## Troubleshooting

### "Access Blocked" message appears instead of a stream

The stream source occasionally refuses connections from certain IP addresses or regions. If you see this message, the source is declining to serve the stream to your current connection — this is outside ChannelSurfer's control and is not a bug in the app.

Try again later. The block is often temporary.

### A channel opens but the pane stays blank or shows "Could not connect to server."

The source site periodically changes both the domain names it uses to serve
streams and the URL path of the player page itself. ChannelSurfer handles
both cases:

- Its allowlist of trusted domains is fetched from a remote config, so new
  domains can be added without rebuilding the app.
- Its list of stream player URLs is also remote, and the app tries them in
  order until one works.

If playback fails on all candidates, look at the terminal output for lines
like this:

```
[14:22:20] [BLOCK ] script   s10.histats.com  ref=dlive.sx
```

The full details of every blocked request (including complete URLs) are also
written to `data/security.log` with lines starting with `[AUTO-BLOCKED]`.

### Deciding what's "stream infrastructure" vs. an ad

The `ref=` column is your best evidence — it shows *which page* requested the
blocked domain:

- `ref=dlive.sx` (or another core stream-site domain) means the request came
  from the outer player page — the source's own ad and tracking scripts.
  **Leave these blocked.**
- `ref=iplayer.is` or `ref=<some obfuscated domain>` means the request came
  from inside the player chain itself (iframes, the video player, token
  handshakes). If playback is failing, these are your whitelist candidates —
  add the domain to `safeDomains`.

Domains also fall into two rough categories by appearance:

- **Ads and trackers** — often random-looking domains ending in `.com`,
  `.xyz`, `.site`, `.space`, or `.online`, frequently serving `.js`, `.css`,
  or tracking `xhr`/`ping` requests.
- **Stream infrastructure** — often served from CDNs or domains that appear
  alongside actual video playback (HLS manifests, segments, encryption keys).

If you're unsure, err on the side of leaving a domain blocked, and add it
only if playback is failing and the domain appears in the block list at the
same moment. When in doubt, add one domain at a time and retest.

## Build

```bash
npm install             # first run only
npm run package         # macOS (.dmg)
npm run package:win     # Windows (.zip)
npm run package:linux   # Linux (.tar.gz)
```

Output goes to `dist/`.

**Packaging note:** the packaged app must include `src/preload.js` (the
renderer-to-main IPC bridge). If it is missing, the app will still launch,
but silently fall back to a degraded mode with no remote config and no
stream status updates. Verify the packager copies `src/` alongside
`main.js`.

## Contributing

Bug reports and feature requests are welcome — please [open an issue](https://github.com/channelsurfer-1/ChannelSurfer/issues).

## License

GPL-3.0. See [LICENSE](LICENSE) for details.

## Credits

Built by DeepSeek 2 and Kimi.ai (Free Editions), under the direction of Joel Budgor.
Inspired by [domainus/LiveTv-English](https://github.com/domainus/LiveTv-English).

## Built With

- [Electron](https://electronjs.org/) — cross-platform desktop framework
- [@electron/packager](https://github.com/electron/packager) — packaging and distribution

## Disclaimer

ChannelSurfer is a viewer that plays publicly available streams. The maintainers
are not responsible for the content of those streams or for compliance with
local laws regarding their use.
