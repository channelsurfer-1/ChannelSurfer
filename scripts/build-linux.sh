#!/bin/bash

cd "$(dirname "$0")/.."

# Create dist directory if it doesn't exist
mkdir -p dist

# Remove old Linux builds
rm -rf dist/ChannelSurfer-linux-x64 2>/dev/null
rm -rf dist/ChannelSurfer-linux-arm64 2>/dev/null

# Install dependencies (skip audit to avoid npm hang)
npm install --no-audit --no-fund

# Fetch fresh EPG data
node src/fetchEpg.js

# Generate schedule data
node src/generateScheduleJson.js

# Stage images/ for packaging, excluding local-only content
echo "Staging images..."
rm -rf .staging-images
mkdir -p .staging-images
rsync -a \
  --exclude='.DS_Store' \
  --exclude='original/' \
  --exclude='*.log.txt' \
  --exclude='rename*.sh' \
  --exclude='process-minimal.js' \
  images/ .staging-images/images/

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

# Build x64 Linux
echo "Building Linux x64 version..."
npx electron-packager . ChannelSurfer \
  --platform=linux \
  --arch=x64 \
  --out=dist \
  --overwrite \
  --icon=images/ChannelSurfer.png \
  "${IGNORE_PATTERNS[@]}"

# Package the output as a tar.gz for distribution
echo "Creating distribution tarball..."
rm -f dist/ChannelSurfer-linux-x64.tar.gz
(cd dist && tar -czf ChannelSurfer-linux-x64.tar.gz ChannelSurfer-linux-x64)

# Clean up staging
rm -rf .staging-images

echo "Build complete!"
echo "Created:"
echo "  - dist/ChannelSurfer-linux-x64/ChannelSurfer"
echo "  - dist/ChannelSurfer-linux-x64.tar.gz"