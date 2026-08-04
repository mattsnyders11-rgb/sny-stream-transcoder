FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server ./server

ENV NODE_ENV=production \
    HOST=:: \
    PORT=3002 \
    TRANSCODE_DIR=/tmp/sny-transcoder

RUN mkdir -p /tmp/sny-transcoder

EXPOSE 3002
CMD ["npm", "start"]
