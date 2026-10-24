#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd "$(dirname "$0")" && pwd)"
font_file="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
test -f "$font_file"
command -v ffmpeg >/dev/null

for scene in bright dark detailed; do
  case "$scene" in
    bright) treatment='eq=brightness=0.22:saturation=0.8' ;;
    dark) treatment='eq=brightness=-0.3:saturation=0.8' ;;
    detailed) treatment='noise=alls=24:allf=t+u' ;;
  esac
  ffmpeg -nostdin -y -v error \
    -f lavfi -i 'testsrc2=size=640x360:rate=20' -t 12 \
    -vf "${treatment},drawtext=fontfile=${font_file}:text='Owned subtitle area':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.75:boxborderw=7:x=(w-text_w)/2:y=h-48" \
    -an -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p \
    -movflags +faststart -f mp4 "$fixture_dir/viewing-${scene}.mp4"
done

sha256sum "$fixture_dir"/viewing-*.mp4
