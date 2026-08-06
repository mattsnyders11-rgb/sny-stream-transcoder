# SNY Universal Playback Engine v1 — FFmpeg Worker

This service converts an authorised remote media URL into a Safari-compatible HLS stream:

- H.264 video, maximum 1280 px width / 720p height
- AAC stereo audio
- fragmented-MP4 HLS segments
- one active job by default
- automatic cleanup after two hours

## Railway service variables

- `TRANSCODER_SECRET`: same 24+ character random value used by the main SNY Stream service
- `TRANSCODER_PUBLIC_URL`: public Railway URL of this worker, without trailing slash
- `MAX_CONCURRENT_JOBS=1`
- optional: `FFMPEG_PRESET=veryfast`, `FFMPEG_CRF=23`

The main SNY Stream service needs:

- `TRANSCODER_INTERNAL_URL`: the worker's Railway URL
- `TRANSCODER_SECRET`: the same shared secret
- `APP_SECRET`: an existing 24+ character secret

This first version is deliberately a compatibility proof-of-concept. It transcodes one rendition rather than generating an adaptive quality ladder.

## English Audio Guard (worker v1.1)

The worker now probes all embedded audio tracks before HLS generation. It selects normal English ahead of commentary/descriptive English, maps the selected stream explicitly, and returns a retryable `ENGLISH_AUDIO_NOT_AVAILABLE` result for confirmed foreign-only files. Unknown language tags remain allowed as a fallback.

Optional variable:

- `PROBE_CACHE_TTL_SECONDS=3600` caches audio-track inspection by resolved URL.
