#!/bin/bash

# =============================================
# DOWNLOAD CHANNEL LOGOS WITH PROPER NAMES
# =============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/channel_logos"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

mkdir -p "${OUTPUT_DIR}"

log "Fetching channel page..."
curl -s "https://flixed.io/channels" -o /tmp/flixed_channels.html

log "Extracting channel names and logo URLs from JSON..."

python3 << 'PYEOF'
import re
import json
import os
import urllib.request
import html as html_module

with open('/tmp/flixed_channels.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the __NEXT_DATA__ JSON
next_data_match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', content, re.DOTALL)

if not next_data_match:
    print("ERROR: Could not find __NEXT_DATA__ JSON")
    exit(1)

json_str = next_data_match.group(1)
data = json.loads(json_str)

# Navigate to the channels list
try:
    channels = data['props']['pageProps']['channels']
except (KeyError, TypeError):
    print("ERROR: Could not find channels in JSON structure")
    exit(1)

output_dir = 'channel_logos'
os.makedirs(output_dir, exist_ok=True)

downloaded = 0
failed = 0
skipped = 0

for channel in channels:
    name = channel.get('name', '')
    logo_url = channel.get('logoUrl', '')
    
    if not name or not logo_url:
        continue
    
    # Clean up channel name for filename
    name_clean = html_module.unescape(name)
    # Remove characters problematic in filenames
    name_clean = re.sub(r'[^\w\s-]', '', name_clean)
    name_clean = name_clean.strip().replace(' ', '_')
    
    # Get file extension from URL
    # Strip query parameters first
    url_path = logo_url.split('?')[0]
    ext_match = re.search(r'\.(png|jpg|jpeg|webp|svg)$', url_path, re.IGNORECASE)
    ext = ext_match.group(1).lower() if ext_match else 'png'
    
    filename = f"{name_clean}.{ext}"
    filepath = os.path.join(output_dir, filename)
    
    # Skip if already downloaded
    if os.path.exists(filepath):
        skipped += 1
        continue
    
    try:
        print(f"  Downloading: {name} → {filename}")
        urllib.request.urlretrieve(logo_url, filepath)
        downloaded += 1
    except Exception as e:
        print(f"  Failed: {name} ({e})")
        failed += 1

print(f"\nDownloaded: {downloaded}")
print(f"Failed: {failed}")
print(f"Skipped (already exists): {skipped}")
PYEOF

log "Done! Logos saved to ${OUTPUT_DIR}"