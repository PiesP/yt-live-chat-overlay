# Native autoplay input

`autoplay-av.webm` is a source-owned, two-second 160 × 90 VP8 video with a
440 Hz Opus audio track. It contains a flat teal frame and generated audio.
The Windows player fixture checks its SHA-256 before routing it to the owned
page. This file is validation input and is excluded from product builds.

The encoded input is used before any capture stream or Web Audio source is
created. After an actual autoplay rejection, trusted Play must decode this
same input and advance its time and frames before the capture-based tests run.

The separate ignored `viewing-*.mp4` clips belong to the #327 viewing baseline.
Generate them with `generate-viewing-experience.sh`; `viewing-experience.ts` pins
their hashes, and `profile.json` includes their exact bytes in the Windows bundle.
Do not substitute this flat teal autoplay input for moving-video readability.

To regenerate the input, review the resulting streams and update the fixture's
hash; muxer metadata can change the exact bytes:

```sh
ffmpeg -nostdin -v error \
  -f lavfi -i color=c=teal:s=160x90:r=10 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 2 -c:v libvpx -b:v 50k -c:a libopus -b:a 16k \
  -f webm validation/windows/fixtures/autoplay-av.webm
```
