This app was built by DeepSeek 2 (Free Edition), under the direction of Joel Budgor.
This app derives from the work of https://github.com/domainus/LiveTv-English

# ChannelSurfer

A desktop application for browsing and watching live TV streams with a rich, modern program guide.

## Features

### 📋 Program Guide
Browse current programming across all available stations.

- Click an empty panel to open the program guide
- Station logos displayed next to channel names
- Program titles and descriptions on hover
- Guide automatically refreshes as programs change
- Each panel remembers its place in the guide when you return to it

### 🖥️ Multi-View Watching
Watch multiple channels at once.

- **Single View** — Focus on one stream
- **Split View** — Watch two channels together
- **Quad View** — Watch up to four channels together
- Each view mode maintains its own independent panel assignments
- Individual panes expand to fullscreen when the player's fullscreen button is clicked

### 🛡️ Built-in Protection
ChannelSurfer blocks intrusive ads, trackers, and malicious domains.

- Default-deny network policy
- Streaming content allowed from any domain
- Security log for blocked requests

### 🌙 Modern Dark Interface
Designed for comfortable viewing in low-light environments.

- Clean dark theme
- Station logos in badge format
- Program name labels on each pane
- Tooltips with program descriptions on hover

## Program Guide Accuracy

The guide relies on publicly available EPG data.

It works well for national networks. Broadcast networks like CBS, ABC, NBC, and FOX may not always match the exact local feed used by the stream source.

Treat the schedule as a helpful guide rather than an authoritative source.

## How It Works

1. Launch the app
2. Click "Click to select a program" in any panel
3. Browse the program guide that appears
4. Click a program to fill that panel
5. Switch between Single, Split, or Quad view using the mode selector
6. Close streams with the X button on each pane to return to the guide

## Build

```bash
npm run package