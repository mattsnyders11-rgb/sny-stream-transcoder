# SNY Universal Playback Engine v1

This package activates the compatibility bridge that was already present in `server/transcoder.js` and adds a deployable FFmpeg worker.

## What v1 does

1. The existing provider/debrid resolver returns the original media URL.
2. The main server creates a signed, short-lived compatibility ticket.
3. On iPhone/iPad, SNY Stream requests Compatibility Mode immediately.
4. On other browsers, SNY Stream tries direct playback first and falls back after a codec/player failure.
5. The worker outputs HLS with H.264 video and AAC audio.
6. Safari uses native HLS; other supported browsers use the included `hls.js` library.
7. Existing autoplay source fallback continues if the compatibility job itself fails.

## Railway deployment

Create a second Railway service from the same repository and set its root directory to:

`transcoder-worker`

Railway should build it from `transcoder-worker/Dockerfile`.

Worker variables:

- `TRANSCODER_SECRET=<long random value>`
- `TRANSCODER_PUBLIC_URL=https://YOUR-WORKER.up.railway.app`
- `MAX_CONCURRENT_JOBS=1`

Main website variables:

- `TRANSCODER_INTERNAL_URL=https://YOUR-WORKER.up.railway.app`
- `TRANSCODER_SECRET=<the exact same value>`
- ensure `APP_SECRET` is at least 24 characters

After both services redeploy, open:

`https://snystream.co.za/api/compatibility/status`

Expected response:

`{"configured":true,"output":"HLS / H.264 / AAC"}`

## First test

Use one authorised movie source on iPhone Safari. The loading screen should say “Preparing mobile-compatible playback…” and then begin an HLS stream.

## v1 limits

- 720p single rendition
- one active conversion by default
- conversion uses worker CPU continuously while watching
- no shared object storage/CDN yet
- no persistent cache across worker restarts
- subtitles are not yet converted to WebVTT

These are intentional boundaries for the first end-to-end phone playback test.
