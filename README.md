# SNYStream Transcoder Worker v1.2.2

This Railway service probes authorised remote media files and produces HLS playback with an explicitly selected audio track.

## English audio handoff

v1.2.2 adds prebuffered handoff support:

- waits for at least three complete HLS segments;
- requires generated media to be ahead of real elapsed time;
- reports ready segment count, ready duration, source duration and handoff buffer;
- lets the website keep the current source playing until the replacement is ready.

## Required variables

```text
TRANSCODER_SECRET=<same 24+ character secret as the main service>
MAX_ACTIVE_JOBS=2
```

`MAX_ACTIVE_JOBS=2` is required so one active compatibility stream can remain available while a replacement audio stream is prepared.

## Optional tuning

```text
MIN_READY_SEGMENTS=3
MIN_HANDOFF_BUFFER_SECONDS=4
SEGMENT_SECONDS=4
STARTUP_READY_TIMEOUT_SECONDS=28
PROBE_CACHE_TTL_SECONDS=3600
```

The main SNYStream service also needs:

```text
TRANSCODER_INTERNAL_URL=<worker base URL>
TRANSCODER_PUBLIC_URL=<worker public base URL>
TRANSCODER_SECRET=<same shared secret>
APP_SECRET=<stable 24+ character secret>
```
