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
