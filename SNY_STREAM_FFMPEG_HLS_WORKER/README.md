# SNY Stream Universal Device Playback Worker v1.8

This is the separate Compatibility Mode service. It is not uploaded into the
existing SNY Stream repository.

## What it does

1. Receives an authenticated request from the main SNY Stream server.
2. Opens the exact source the viewer selected.
3. Uses FFmpeg to convert video to H.264 High 4.1, 8-bit `yuv420p`, at a
   maximum of 1080p and 30 fps.
4. Converts audio to AAC-LC, 48 kHz, two-channel stereo.
5. Packages the result as HLS with a fragmented-MP4 initialization file and
   two-second `.m4s` media segments.
6. Returns a temporary signed HLS URL to the SNY Stream player.
7. Stops and removes the temporary session after playback closes or becomes idle.

The worker does not search for, filter, hide, or replace sources.

## GitHub and Railway deployment

1. Create a new GitHub repository named `sny-stream-transcoder`.
2. Upload the contents of this folder to the root of the new repository.
   `Dockerfile`, `package.json`, and `railway.json` must be at repository root.
3. In the existing SNY Stream Railway project, create a new service from that
   repository.
4. Name the Railway service `sny-transcoder`.
5. In Railway networking, generate a public domain for the worker.
6. Add the variables below.
7. Deploy and open `/health` on the public worker domain. It should report
   `"ok": true`.

## Required Railway variables

```text
HOST=::
PORT=3002
TRANSCODER_SECRET=USE-A-LONG-RANDOM-SECRET
TRANSCODER_PUBLIC_URL=https://YOUR-WORKER-DOMAIN.up.railway.app
ALLOWED_ORIGIN=https://snystream.co.za
```

`TRANSCODER_PUBLIC_URL` must be the worker's public HTTPS domain without a
trailing slash. The browser needs this public address to fetch the HLS
playlist and segments.

Use the exact same `TRANSCODER_SECRET` in the main SNY Stream service.

## Recommended first-beta variables

```text
TRANSCODE_DIR=/tmp/sny-transcoder
MAX_CONCURRENT_JOBS=1
JOB_IDLE_TTL_SECONDS=300
JOB_STARTUP_TIMEOUT_SECONDS=75
TRANSCODE_MAX_HEIGHT=1080
TRANSCODE_VIDEO_BITRATE=5000k
TRANSCODE_AUDIO_BITRATE=160k
TRANSCODE_PRESET=veryfast
```

Do not set `ALLOW_PRIVATE_SOURCE_URLS=true` in production.

## Main SNY Stream variables

In the existing main service:

```text
TRANSCODER_INTERNAL_URL=http://sny-transcoder.railway.internal:3002
TRANSCODER_SECRET=THE-SAME-SECRET-AS-THE-WORKER
```

If you choose a different Railway service name, use that exact name in the
`.railway.internal` address.

## Included safety controls

- Shared-secret protection on job creation and deletion.
- Short-lived signed media tickets from the main server.
- Signed HLS playback URLs.
- Source URL validation.
- Private and reserved destination blocking.
- One simultaneous transcode by default.
- Automatic idle cleanup.
- Automatic FFmpeg termination when a player closes.
- CORS restricted to the SNY Stream website.

## Health check

Open:

```text
https://YOUR-WORKER-DOMAIN.up.railway.app/health
```

A healthy response includes:

```json
{
  "ok": true,
  "output": "HLS fMP4 / H.264 High 4.1 / AAC-LC stereo",
  "segmentSeconds": 2,
  "pixelFormat": "yuv420p",
  "maxFrameRate": 30,
  "maxConcurrentJobs": 1
}
```

## Notes

The Dockerfile installs FFmpeg automatically. No FFmpeg installation is
required on a viewer's computer.

This version uses CPU transcoding. Keep one active Compatibility Mode job on
small Railway instances. Increase `MAX_CONCURRENT_JOBS` only after CPU and
memory measurements show that the worker can encode every stream in real time.

## Locked compatibility profile

```text
Delivery: HLS version 7
Segments: fragmented MP4 (.m4s), 2 seconds
Video: H.264/AVC High profile, Level 4.1
Video pixel format: yuv420p, 8-bit
Maximum output: 1920x1080 at 30 fps
Audio: AAC-LC, 48 kHz, stereo
Subtitles: excluded from the compatibility rendition
```

Safari/iPhone plays this HLS stream natively. Chrome, Edge and Firefox use the
vendored HLS.js player already included in SNY Stream. The main website first
tries a resolved direct/provider-native source and automatically starts this
worker after an unsupported-source error or startup timeout.
