import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createJob, getJob, getWorkerStatus, stopJob } from './job-manager.js';
import { verifyPlaybackToken, verifySharedSecret } from './security.js';

const HOST = process.env.HOST || '::';
const PORT = Number(process.env.PORT) || 3002;
const ALLOWED_ORIGIN = String(process.env.ALLOWED_ORIGIN || 'https://snystream.co.za');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function setCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin && (origin === ALLOWED_ORIGIN || ALLOWED_ORIGIN === '*')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON request body.')); }
    });
    req.on('error', reject);
  });
}

function rewritePlaylist(text, token) {
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const separator = trimmed.includes('?') ? '&' : '?';
    return `${trimmed}${separator}token=${encodeURIComponent(token)}`;
  }).join('\n');
}

function serveHls(req, res, pathname, searchParams) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) return sendText(res, 405, 'Method not allowed');

  const match = pathname.match(/^\/hls\/([A-Za-z0-9_-]{12,80})\/(index\.m3u8|segment_\d{6}\.ts)$/);
  if (!match) return sendText(res, 404, 'Not found');
  const [, jobId, filename] = match;
  const token = searchParams.get('token') || '';
  if (!verifyPlaybackToken(jobId, token)) return sendText(res, 403, 'Invalid playback token');

  const job = getJob(jobId);
  if (!job) return sendText(res, 404, 'This compatibility session has expired.');
  const filePath = path.join(job.directory, filename);
  if (!filePath.startsWith(path.resolve(job.directory))) return sendText(res, 403, 'Forbidden');

  if (filename.endsWith('.m3u8')) {
    try {
      const playlist = rewritePlaylist(fs.readFileSync(filePath, 'utf8'), token);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': res.getHeader('Access-Control-Allow-Origin') || ALLOWED_ORIGIN,
        'Vary': 'Origin'
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(playlist);
    } catch {
      return sendText(res, job.state === 'failed' ? 502 : 404, job.error || 'Playlist is not ready.');
    }
  }

  let stat;
  try { stat = fs.statSync(filePath); }
  catch { return sendText(res, job.state === 'failed' ? 502 : 404, job.error || 'Segment is not ready.'); }

  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': res.getHeader('Access-Control-Allow-Origin') || ALLOWED_ORIGIN,
    'Vary': 'Origin'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = url;

  if (pathname.startsWith('/hls/')) return serveHls(req, res, pathname, searchParams);

  if (pathname === '/health' && req.method === 'GET') {
    const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    return sendJson(res, ffmpeg.status === 0 ? 200 : 503, {
      ok: ffmpeg.status === 0,
      ffmpeg: ffmpeg.status === 0 ? String(ffmpeg.stdout).split('\n')[0] : null,
      ...getWorkerStatus()
    });
  }

  if (pathname === '/v1/jobs' && req.method === 'POST') {
    if (!verifySharedSecret(req)) return sendJson(res, 401, { error: 'Invalid transcoder secret.' });
    const body = await readJson(req);
    const job = await createJob({ sourceUrl: body.sourceUrl, startSeconds: body.startSeconds });
    return sendJson(res, 201, job);
  }

  const jobMatch = pathname.match(/^\/v1\/jobs\/([A-Za-z0-9_-]{12,80})$/);
  if (jobMatch && req.method === 'DELETE') {
    if (!verifySharedSecret(req)) return sendJson(res, 401, { error: 'Invalid transcoder secret.' });
    const removed = await stopJob(jobMatch[1]);
    return sendJson(res, 200, { stopped: removed });
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch(error => {
    console.error('Transcoder request failed:', error);
    if (!res.headersSent) {
      sendJson(res, Number(error.statusCode) || 500, { error: error.message || 'Transcoder error.' });
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SNY Stream transcoder listening on ${HOST}:${PORT}`);
  console.log(`Output: HLS / H.264 / AAC | Max jobs: ${getWorkerStatus().maxConcurrentJobs}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
