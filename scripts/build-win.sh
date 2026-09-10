#!/bin/bash

cd "$(dirname "$0")/.."

# Create dist directory if it doesn't exist
mkdir -p dist

# Remove old Windows builds
rm -rf dist/ChannelSurfer-win32-x64 2>/dev/null
rm -rf dist/ChannelSurfer-win32-arm64 2>/dev/null

# Install dependencies (skip audit to avoid npm hang)
npm install --no-audit --no-fund

# Fetch fresh EPG data
node src/fetchEpg.js

# Generate schedule data
node src/generateScheduleJson.js

# Common ignore patterns
IGNORE_PATTERNS=(
  "--ignore=^/ChannelSurfer\\.dmg$"
  "--ignore=^/ChannelSurfer-intel\\.dmg$"
  "--ignore=^/ChannelSurfer-universal\\.dmg$"
  "--ignore=^/scripts$"
  "--ignore=^/documentation$"
  "--ignore=^/node_modules$"
  "--ignore=^/runtime$"
  "--ignore=^/dist$"
  "--ignore=^/data/epg_ripper_US2\\.xml$"
  "--ignore=^/data/epg_ripper_US2\\.xml\\.gz$"
  "--ignore=^/data/schedule\\.json$"
  "--ignore=^/data/security\\.log$"
  "--ignore=^/data/blocklist\\.txt$"
  "--extra-resource=images"
)

# Build x64 (standard Windows)
echo "Building Windows x64 version..."
npx electron-packager . ChannelSurfer \
  --platform=win32 \
  --arch=x64 \
  --out=dist \
  --overwrite \
  --icon=images/icon.ico \
  "${IGNORE_PATTERNS[@]}"

echo "Build complete!"
echo "Created: dist/ChannelSurfer-win32-x64/ChannelSurfer.exe"