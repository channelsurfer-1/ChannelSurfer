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
node src/fetchEpg.js || { echo "EPG fetch failed — aborting build"; exit 1; }

# Generate schedule data
node src/generateScheduleJson.js || { echo "Schedule generation failed — aborting build"; exit 1; }

# Stage images/ for packaging, excluding local-only content
echo "Staging images..."
node scripts/stage-images.js images .staging-images/images

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
  "--ignore=^/.staging-images$"
  "--ignore=^/data/epg_ripper_US2\\.xml$"
  "--ignore=^/data/epg_ripper_US2\\.xml\\.gz$"
  "--ignore=^/data/schedule\\.json$"
  "--ignore=^/data/security\\.log$"
  "--ignore=^/data/blocklist\\.txt$"
  "--extra-resource=.staging-images/images"
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

# Package the output as a zip for distribution
echo "Creating distribution zip..."
rm -f dist/ChannelSurfer-win32-x64.zip
if command -v zip >/dev/null 2>&1; then
  (cd dist && zip -r -X ChannelSurfer-win32-x64.zip ChannelSurfer-win32-x64)
elif command -v 7z >/dev/null 2>&1; then
  (cd dist && 7z a -tzip ChannelSurfer-win32-x64.zip ChannelSurfer-win32-x64)
else
  echo "Error: neither zip nor 7z is available to create the distribution archive." >&2
  exit 1
fi

# Clean up staging
rm -rf .staging-images

echo "Build complete!"
echo "Created:"
echo "  - dist/ChannelSurfer-win32-x64/ChannelSurfer.exe"
echo "  - dist/ChannelSurfer-win32-x64.zip"
