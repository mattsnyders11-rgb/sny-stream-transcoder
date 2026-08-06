# SNYStream transcoder — clean repository

This repository contains only the active transcoder worker. Keep every file at the repository root.

## Railway

- Root Directory: leave blank
- Builder: Dockerfile
- Health check: `/health`
- Start command: supplied by Dockerfile (`node server.js`)

## Variables

Required: `TRANSCODER_SECRET`
Optional: `FFMPEG_CRF`, `FFMPEG_PRESET`, `MAX_ACTIVE_JOBS`

The legacy name `MAX_CONCURRENT_JOBS` is also accepted by this cleaned worker. `TRANSCODER_PUBLIC_URL` is not used inside the worker; it belongs on the main website service.
