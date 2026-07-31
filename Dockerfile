FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server.js ./
RUN mkdir -p /tmp/sny-hls
ENV NODE_ENV=production
CMD ["node", "server.js"]
