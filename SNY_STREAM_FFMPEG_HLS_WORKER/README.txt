SNY Stream Transcoder Worker v1

This isolated Railway service contains FFmpeg and creates temporary HLS output.
It is controlled by the main SNY Stream backend through a shared secret.

Required:
PORT=8080
TRANSCODER_SECRET=<same secret as main service>

Recommended private beta:
MAX_ACTIVE_JOBS=2
MAX_OUTPUT_WIDTH=1920
VIDEO_CRF=22
FFMPEG_PRESET=veryfast
ALLOW_PRIVATE_SOURCES=false

Health endpoint:
GET /health

The /v1 endpoints require x-sny-transcoder-secret.
The /hls/<unguessable-job-id>/ files are public so browsers can play them.
