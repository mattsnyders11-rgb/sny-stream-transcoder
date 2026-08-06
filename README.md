# SNYStream Transcoder Worker v1.3.0

This Railway service probes authorised remote media files and produces HLS playback with an explicitly selected audio track.

## English-ready loading

v1.3.0 replaces the failed moving handoff with preparation behind the normal SNYStream loading screen:

- probes the embedded audio tracks before playback is shown;
- selects normal English ahead of commentary or descriptive audio;
- waits for at least three complete HLS segments;
- waits for at least 12 seconds of initial buffered media by default;
- reports the verified source duration and available audio tracks;
- starts the player only after the English stream is ready.

Manual audio changes use the same loading-first process from the viewer's current timestamp.

## Required variables

```text
TRANSCODER_SECRET=<same 24+ character secret as the main service>
MAX_ACTIVE_JOBS=2
```

`MAX_ACTIVE_JOBS=2` is recommended so an existing compatibility session can remain available while another selected audio track is prepared.

## Optional tuning

```text
MIN_READY_SEGMENTS=3
MIN_INITIAL_BUFFER_SECONDS=12
INITIAL_READY_TIMEOUT_SECONDS=60
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
