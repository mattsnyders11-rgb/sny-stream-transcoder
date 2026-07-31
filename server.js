import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';
const SECRET = String(process.env.TRANSCODER_SECRET || '').trim();
const PUBLIC_BASE_URL = String(process.env.TRANSCODER_PUBLIC_URL || '').replace(/\/+$/, '');
const OUTPUT_ROOT = process.env.HLS_OUTPUT_DIR || '/tmp/sny-hls';
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS) || 1);
const JOB_TTL_MS = Math.max(15 * 60_000, Number(process.env.JOB_TTL_MS) || 2 * 60 * 60_000);
const STARTUP_WAIT_MS = Math.max(10_000, Number(process.env.STARTUP_WAIT_MS) || 45_000);

fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
const jobs = new Map();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorised(req) {
  return SECRET.length >= 24 && safeEqual(req.headers['x-sny-transcoder-secret'], SECRET);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_000) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function activeJobCount() {
  return [...jobs.values()].filter(job => ['starting', 'running'].includes(job.state)).length;
}

function safeJobId(value) {
  return /^[A-Za-z0-9_-]{12,80}$/.test(String(value || '')) ? String(value) : null;
}

function removeDirectory(directory) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
}

function stopJob(job) {
  if (!job) return false;
  if (job.process && !job.process.killed) {
    try { job.process.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { job.process?.kill('SIGKILL'); } catch {} }, 4000).unref();
  }
  job.state = 'stopped';
  job.updatedAt = Date.now();
  return true;
}

function ffmpegArgs(sourceUrl, outputDir, startSeconds) {
  const manifest = path.join(outputDir, 'master.m3u8');
  const segmentPattern = path.join(outputDir, 'segment-%06d.m4s');
  const args = ['-hide_banner', '-loglevel', 'warning'];
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push(
    '-i', sourceUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-vf', "scale=w='min(1280,iw)':h=-2:force_original_aspect_ratio=decrease",
    '-c:v', 'libx264',
    '-preset', process.env.FFMPEG_PRESET || 'veryfast',
    '-crf', process.env.FFMPEG_CRF || '23',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-level', '4.0',
    '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '48000',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', segmentPattern,
    '-hls_flags', 'independent_segments+append_list+temp_file',
    manifest
  );
  return args;
}

function waitForManifest(job) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(job.manifestPath) && fs.statSync(job.manifestPath).size > 20) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (job.state === 'failed' || job.state === 'stopped') {
        clearInterval(timer);
        reject(new Error(job.error || 'The compatibility job stopped before the playlist was ready.'));
        return;
      }
      if (Date.now() - started >= STARTUP_WAIT_MS) {
        clearInterval(timer);
        reject(new Error('The compatibility playlist was not ready in time.'));
      }
    }, 300);
    timer.unref?.();
  });
}

async function createJob({ sourceUrl, startSeconds = 0 }) {
  if (activeJobCount() >= MAX_CONCURRENT_JOBS) {
    const error = new Error('The compatibility server is busy.');
    error.statusCode = 429;
    throw error;
  }
  let parsed;
  try { parsed = new URL(String(sourceUrl || '')); } catch { parsed = null; }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('A valid HTTP media URL is required.');
    error.statusCode = 400;
    throw error;
  }

  const jobId = crypto.randomBytes(16).toString('base64url');
  const outputDir = path.join(OUTPUT_ROOT, jobId);
  fs.mkdirSync(outputDir, { recursive: true });
  const job = {
    id: jobId,
    state: 'starting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    outputDir,
    manifestPath: path.join(outputDir, 'master.m3u8'),
    process: null,
    error: null
  };
  jobs.set(jobId, job);

  const child = spawn('ffmpeg', ffmpegArgs(parsed.toString(), outputDir, Math.max(0, Number(startSeconds) || 0)), {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  job.process = child;
  job.state = 'running';
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  child.once('error', error => {
    job.state = 'failed';
    job.error = error.message;
    job.updatedAt = Date.now();
  });
  child.once('exit', code => {
    job.updatedAt = Date.now();
    if (job.state === 'stopped') return;
    if (code === 0) job.state = 'completed';
    else {
      job.state = 'failed';
      job.error = stderr.trim() || `FFmpeg exited with code ${code}.`;
    }
  });

  try {
    await waitForManifest(job);
  } catch (error) {
    stopJob(job);
    throw error;
  }

  const base = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  return {
    jobId,
    hlsUrl: `${base}/hls/${jobId}/master.m3u8`,
    mode: 'transcode-h264-aac-720p'
  };
}

function contentType(file) {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (file.endsWith('.m4s') || file.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

function serveHls(req, res, pathname) {
  const match = pathname.match(/^\/hls\/([A-Za-z0-9_-]{12,80})\/(master\.m3u8|init\.mp4|segment-\d+\.m4s)$/);
  if (!match) return false;
  const [, jobId, filename] = match;
  const job = jobs.get(jobId);
  if (!job) { json(res, 404, { error: 'Stream expired.' }); return true; }
  const file = path.join(job.outputDir, filename);
  if (!fs.existsSync(file)) { json(res, 404, { error: 'Segment is not ready.' }); return true; }
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'content-type': contentType(file),
    'content-length': stat.size,
    'cache-control': filename.endsWith('.m3u8') ? 'no-cache' : 'public, max-age=3600',
    'access-control-allow-origin': '*'
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,x-sny-transcoder-secret'
    });
    res.end();
    return;
  }
  if (serveHls(req, res, url.pathname)) return;
  if (url.pathname === '/health') return json(res, 200, { ok: true, jobs: activeJobCount() });

  if (!authorised(req)) return json(res, 401, { error: 'Unauthorised.' });
  try {
    if (url.pathname === '/v1/jobs' && req.method === 'POST') {
      const body = await readJson(req);
      const result = await createJob(body);
      return json(res, 201, result);
    }
    const match = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (match && req.method === 'DELETE') {
      const jobId = safeJobId(match[1]);
      const job = jobId ? jobs.get(jobId) : null;
      if (!job) return json(res, 404, { stopped: false });
      stopJob(job);
      return json(res, 200, { stopped: true });
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error.message || 'Worker error.' });
  }
});

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt > cutoff) continue;
    stopJob(job);
    removeDirectory(job.outputDir);
    jobs.delete(id);
  }
}, 60_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`SNY Transcoder Worker listening on ${HOST}:${PORT}`);
});
