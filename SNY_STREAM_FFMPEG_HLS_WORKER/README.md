# SNY Stream FFmpeg HLS Worker

This is the separate Compatibility Mode service. It can live in its own
repository or in the existing SNY Stream repository under
`/SNY_STREAM_FFMPEG_HLS_WORKER`. Real-Debrid files use Real-Debrid's own
browser-native streams and are deliberately rejected by this worker.

## What it does

1. Receives an authenticated request from the main SNY Stream server.
2. Opens the exact authorised non-Real-Debrid source the viewer selected.
3. Uses FFmpeg to convert video to H.264 and audio to AAC.
4. Packages the result as four-second HLS segments.
5. Returns a temporary signed HLS URL to the SNY Stream player.
6. Stops and removes the temporary session after playback closes or becomes idle.

The worker does not search for, filter, hide, or replace sources.

## GitHub and Railway deployment

1. Keep the current repository arrangement.
2. If this folder is inside the main repository, set Railway Root Directory to
   `/SNY_STREAM_FFMPEG_HLS_WORKER`. If it has its own repository, upload this
   folder's contents to that repository root.
3. Keep the existing transcoder Railway service connected to that location.
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
MIN_READY_SEGMENTS=2
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
- Identical concurrent requests share one job.
- Playback is returned only after two complete HLS segments exist.
- Real-Debrid download URLs are rejected in favour of provider-native playback.
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
  "output": "HLS / H.264 / AAC",
  "maxConcurrentJobs": 1
}
```

## Notes

The Dockerfile installs FFmpeg automatically. No FFmpeg installation is
required on a viewer's computer.

This first beta uses CPU transcoding. Start with one active session and
measure Railway resource use before increasing concurrency.
