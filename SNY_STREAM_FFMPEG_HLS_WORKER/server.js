import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { analyseAudioStreams, assertEnglishPreferredAudio, publicAudioAnalysis } from './audio-language.js';

const PORT = Math.max(1, Number(process.env.PORT) || 8080);
const HOST = process.env.HOST || '::';
const WORK_ROOT = path.resolve(process.env.WORK_DIR || path.join(os.tmpdir(), 'sny-hls'));
const SECRET = String(process.env.TRANSCODER_SECRET || '').trim();
const MAX_ACTIVE_JOBS = clampInt(process.env.MAX_ACTIVE_JOBS, 1, 8, 2);
const JOB_TTL_MS = clampInt(process.env.JOB_TTL_SECONDS, 300, 86_400, 7200) * 1000;
const STARTUP_READY_TIMEOUT_MS = clampInt(process.env.STARTUP_READY_TIMEOUT_SECONDS, 10, 90, 28) * 1000;
const SEGMENT_SECONDS = clampInt(process.env.SEGMENT_SECONDS, 2, 10, 4);
const MAX_OUTPUT_WIDTH = clampInt(process.env.MAX_OUTPUT_WIDTH, 640, 3840, 1920);
const VIDEO_CRF = clampInt(process.env.VIDEO_CRF, 16, 32, 22);
const FFMPEG_PRESET = /^[a-z0-9-]+$/i.test(String(process.env.FFMPEG_PRESET || ''))
  ? String(process.env.FFMPEG_PRESET)
  : 'veryfast';
const ALLOW_PRIVATE_SOURCES = String(process.env.ALLOW_PRIVATE_SOURCES || '').toLowerCase() === 'true';
const PROBE_CACHE_TTL_MS = clampInt(process.env.PROBE_CACHE_TTL_SECONDS, 60, 86_400, 3600) * 1000;

const jobs = new Map();
const probeCache = new Map();
const jobBySourceKey = new Map();
fs.mkdirSync(WORK_ROOT, { recursive: true });

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function optionalNonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorised(req) {
  return SECRET.length >= 24 && safeEqual(req.headers['x-sny-transcoder-secret'], SECRET);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 256_000) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON request body.'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.search = url.search ? '?[redacted]' : '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function isBlockedIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isBlockedIPv6(address) {
  const clean = String(address || '').toLowerCase().split('%')[0];
  if (clean === '::' || clean === '::1') return true;
  if (clean.startsWith('fc') || clean.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(clean)) return true;
  if (clean.startsWith('ff')) return true;
  if (clean.startsWith('::ffff:')) {
    const mapped = clean.slice('::ffff:'.length);
    return net.isIP(mapped) === 4 ? isBlockedIPv4(mapped) : true;
  }
  return false;
}

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

async function validateSourceUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '')); }
  catch { throw Object.assign(new Error('The source URL is invalid.'), { statusCode: 400, code: 'INVALID_SOURCE_URL' }); }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('Only public HTTP or HTTPS source URLs are supported.'), {
      statusCode: 400,
      code: 'UNSUPPORTED_SOURCE_URL'
    });
  }

  if (ALLOW_PRIVATE_SOURCES) return url.toString();

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw Object.assign(new Error('Private source hosts are not allowed.'), { statusCode: 400, code: 'PRIVATE_SOURCE_BLOCKED' });
  }

  let addresses;
  try { addresses = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch {
    throw Object.assign(new Error('The source host could not be resolved.'), { statusCode: 400, code: 'SOURCE_DNS_FAILED' });
  }

  if (!addresses.length || addresses.some(entry => isBlockedAddress(entry.address))) {
    throw Object.assign(new Error('Private or reserved source addresses are not allowed.'), {
      statusCode: 400,
      code: 'PRIVATE_SOURCE_BLOCKED'
    });
  }

  return url.toString();
}

function runCommand(command, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`${command} timed out.`), { code: 'COMMAND_TIMEOUT' }));
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${command} exited with code ${code}.`), {
        code: 'COMMAND_FAILED',
        details: stderr.slice(-2000)
      }));
    });
  });
}

function probeCacheKey(sourceUrl) {
  return crypto.createHash('sha256').update(String(sourceUrl || '')).digest('hex');
}

function getCachedProbe(sourceUrl) {
  const key = probeCacheKey(sourceUrl);
  const cached = probeCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached) probeCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedProbe(sourceUrl, value) {
  probeCache.set(probeCacheKey(sourceUrl), {
    value,
    expiresAt: Date.now() + PROBE_CACHE_TTL_MS
  });
}

async function probeSource(sourceUrl, { useCache = true } = {}) {
  const cached = useCache ? getCachedProbe(sourceUrl) : null;
  if (cached) return cached;

  try {
    const { stdout } = await runCommand('ffprobe', [
      '-v', 'error',
      '-rw_timeout', '10000000',
      '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,channels,channel_layout:stream_tags=language,title,handler_name:stream_disposition=default,comment,descriptions,visual_impaired,hearing_impaired',
      '-of', 'json',
      sourceUrl
    ], { timeoutMs: 25_000 });

    const data = JSON.parse(stdout || '{}');
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const video = streams.find(stream => stream.codec_type === 'video') || null;
    const audioAnalysis = analyseAudioStreams(streams);
    const result = {
      available: Boolean(video),
      formatName: String(data.format?.format_name || ''),
      duration: Number(data.format?.duration) || null,
      video,
      audio: audioAnalysis.selected?.stream || null,
      audioAnalysis
    };
    setCachedProbe(sourceUrl, result);
    return result;
  } catch (error) {
    return {
      available: false,
      formatName: '',
      duration: null,
      video: null,
      audio: null,
      audioAnalysis: {
        status: 'unverified',
        hasAudio: false,
        hasEnglish: false,
        hasKnownForeign: false,
        hasUnknownLanguage: true,
        selected: null,
        defaultAudioStreamIndex: null,
        tracks: []
      },
      probeError: error.message
    };
  }
}

function publicProbePayload(probe) {
  return {
    available: Boolean(probe?.available),
    formatName: probe?.formatName || null,
    duration: Number(probe?.duration) || null,
    video: probe?.video ? {
      index: Number.isInteger(Number(probe.video.index)) ? Number(probe.video.index) : null,
      codec: probe.video.codec_name || null,
      profile: probe.video.profile || null,
      pixelFormat: probe.video.pix_fmt || null,
      width: Number(probe.video.width) || null,
      height: Number(probe.video.height) || null
    } : null,
    audio: publicAudioAnalysis(probe?.audioAnalysis || {}),
    probeError: probe?.probeError || null
  };
}

function selectProbeAudioTrack(probe, requestedAudioStreamIndex = null) {
  const requested = optionalNonNegativeInteger(requestedAudioStreamIndex);
  const hasExplicitSelection = requested !== null;

  if (!hasExplicitSelection) {
    if (!probe.probeError) assertEnglishPreferredAudio(probe.audioAnalysis);
    return probe;
  }

  const track = Array.isArray(probe.audioAnalysis?.tracks)
    ? probe.audioAnalysis.tracks.find(candidate => Number(candidate?.index) === requested)
    : null;
  if (!track?.stream) {
    throw Object.assign(new Error('The requested audio track is no longer available in this source.'), {
      statusCode: 409,
      code: 'AUDIO_TRACK_NOT_FOUND',
      retryable: true
    });
  }

  return {
    ...probe,
    audio: track.stream,
    audioAnalysis: {
      ...probe.audioAnalysis,
      selected: track
    }
  };
}

function selectMode(probe) {
  const videoCodec = String(probe.video?.codec_name || '').toLowerCase();
  const pixelFormat = String(probe.video?.pix_fmt || '').toLowerCase();
  const audioCodec = String(probe.audio?.codec_name || '').toLowerCase();
  const videoCanCopy = videoCodec === 'h264' && (!pixelFormat || ['yuv420p', 'yuvj420p'].includes(pixelFormat));
  const audioCanCopy = !probe.audio || audioCodec === 'aac';

  if (videoCanCopy && audioCanCopy) return 'remux';
  if (videoCanCopy) return 'audio-transcode';
  return 'full-transcode';
}

function ffmpegArgs({ sourceUrl, outputDir, startSeconds, probe, mode }) {
  const playlistPath = path.join(outputDir, 'master.m3u8');
  const segmentPath = path.join(outputDir, 'segment-%06d.ts');
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    '-rw_timeout', '30000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5'
  ];

  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  const selectedAudioIndex = optionalNonNegativeInteger(probe.audio?.index);
  const audioMap = selectedAudioIndex !== null ? `0:${selectedAudioIndex}?` : '0:a:0?';
  args.push('-i', sourceUrl, '-map', '0:v:0', '-map', audioMap, '-sn', '-dn');

  if (mode === 'remux' || mode === 'audio-transcode') {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', FFMPEG_PRESET,
      '-crf', String(VIDEO_CRF),
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-vf', `scale=w='min(iw,${MAX_OUTPUT_WIDTH})':h=-2`,
      '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
      '-sc_threshold', '0'
    );
  }

  if (probe.audio) {
    if (mode === 'remux') args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }

  args.push(
    '-max_muxing_queue_size', '4096',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', segmentPath,
    playlistPath
  );

  return args;
}

function activeJobCount() {
  return [...jobs.values()].filter(job => (
    job.process
    && job.process.exitCode === null
    && !job.process.killed
    && (job.state === 'starting' || job.state === 'running')
  )).length;
}

function jobPublicPayload(job) {
  return {
    jobId: job.id,
    playlistPath: `/hls/${job.id}/master.m3u8`,
    mode: job.mode,
    state: job.state,
    source: {
      format: job.probe.formatName || null,
      videoCodec: job.probe.video?.codec_name || null,
      audioCodec: job.probe.audio?.codec_name || null,
      audioLanguage: job.probe.audioAnalysis?.selected?.language || null,
      audioTitle: job.probe.audioAnalysis?.selected?.title || null,
      audioSelectionStatus: job.probe.audioAnalysis?.status || 'unverified',
      audioStreamIndex: Number.isInteger(job.probe.audioAnalysis?.selected?.index) ? job.probe.audioAnalysis.selected.index : null,
      audioTracks: publicAudioAnalysis(job.probe.audioAnalysis || {}).tracks,
      width: Number(job.probe.video?.width) || null,
      height: Number(job.probe.video?.height) || null
    }
  };
}

function removeJob(job, { deleteFiles = true } = {}) {
  if (!job) return;
  if (job.process && !job.process.killed) {
    job.process.kill('SIGTERM');
    setTimeout(() => {
      if (job.process && !job.process.killed) job.process.kill('SIGKILL');
    }, 3000).unref?.();
  }
  jobs.delete(job.id);
  if (jobBySourceKey.get(job.sourceKey) === job.id) jobBySourceKey.delete(job.sourceKey);
  if (deleteFiles) fs.rm(job.outputDir, { recursive: true, force: true }, () => {});
}

function waitForPlaylist(job) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + STARTUP_READY_TIMEOUT_MS;
    const poll = () => {
      if (!jobs.has(job.id)) return reject(Object.assign(new Error('The compatibility job was cancelled.'), { statusCode: 410 }));

      try {
        const playlist = fs.readFileSync(job.playlistPath, 'utf8');
        const segmentExists = fs.readdirSync(job.outputDir).some(name => /^segment-\d+\.ts$/.test(name));
        if (playlist.includes('#EXTINF:') && segmentExists) {
          job.state = 'running';
          job.readyAt = Date.now();
          return resolve(jobPublicPayload(job));
        }
      } catch {
        // FFmpeg has not produced the first complete segment yet.
      }

      if (job.state === 'failed') {
        return reject(Object.assign(new Error(job.error || 'The compatibility stream could not start.'), {
          statusCode: 502,
          code: 'TRANSCODER_FFMPEG_FAILED'
        }));
      }

      if (Date.now() >= deadline) {
        removeJob(job);
        return reject(Object.assign(new Error('The compatibility stream did not become ready in time.'), {
          statusCode: 504,
          code: 'TRANSCODER_START_TIMEOUT'
        }));
      }

      setTimeout(poll, 250).unref?.();
    };
    poll();
  });
}

async function createJob({ sourceUrl, startSeconds, audioStreamIndex = null }) {
  const validatedUrl = await validateSourceUrl(sourceUrl);
  const safeStartSeconds = Math.min(86_400, Math.max(0, Number(startSeconds) || 0));
  const requestedAudioStreamIndex = optionalNonNegativeInteger(audioStreamIndex);
  const sourceKey = crypto.createHash('sha256')
    .update(`${validatedUrl}|${safeStartSeconds}|${requestedAudioStreamIndex ?? 'auto'}`)
    .digest('hex');
  const existingId = jobBySourceKey.get(sourceKey);
  const existing = existingId ? jobs.get(existingId) : null;
  if (existing && ['starting', 'running', 'completed'].includes(existing.state)) {
    existing.lastAccessAt = Date.now();
    if (fs.existsSync(existing.playlistPath)) return jobPublicPayload(existing);
    return waitForPlaylist(existing);
  }

  if (activeJobCount() >= MAX_ACTIVE_JOBS) {
    throw Object.assign(new Error('The compatibility server is busy. Try another source shortly.'), {
      statusCode: 503,
      code: 'TRANSCODER_BUSY',
      retryable: true
    });
  }

  const baseProbe = await probeSource(validatedUrl);
  const probe = selectProbeAudioTrack(baseProbe, requestedAudioStreamIndex);
  const mode = selectMode(probe);
  const id = crypto.randomBytes(18).toString('base64url');
  const outputDir = path.join(WORK_ROOT, id);
  fs.mkdirSync(outputDir, { recursive: true });

  const job = {
    id,
    sourceKey,
    sourceUrl: validatedUrl,
    sourceLogUrl: redactUrl(validatedUrl),
    outputDir,
    playlistPath: path.join(outputDir, 'master.m3u8'),
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    readyAt: null,
    state: 'starting',
    mode,
    probe,
    process: null,
    error: null,
    logTail: ''
  };

  jobs.set(id, job);
  jobBySourceKey.set(sourceKey, id);

  const child = spawn('ffmpeg', ffmpegArgs({
    sourceUrl: validatedUrl,
    outputDir,
    startSeconds: safeStartSeconds,
    probe,
    mode
  }), { stdio: ['ignore', 'ignore', 'pipe'] });

  job.process = child;
  child.stderr.on('data', chunk => {
    job.logTail = `${job.logTail}${chunk.toString()}`.slice(-5000);
  });
  child.once('error', error => {
    job.state = 'failed';
    job.error = error.message;
  });
  child.once('close', code => {
    job.process = null;
    if (code === 0) {
      job.state = fs.existsSync(job.playlistPath) ? 'completed' : 'failed';
      if (job.state === 'failed') job.error = 'FFmpeg exited without creating a playlist.';
    } else if (job.state !== 'failed') {
      job.state = 'failed';
      job.error = `FFmpeg exited with code ${code}. ${job.logTail.slice(-1200)}`;
    }
  });

  console.log(`[transcoder] ${id} ${mode} ${job.sourceLogUrl}`);
  return waitForPlaylist(job);
}

function contentType(filename) {
  if (filename.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (filename.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}

function serveHls(pathname, req, res) {
  const match = pathname.match(/^\/hls\/([A-Za-z0-9_-]{16,80})\/(master\.m3u8|segment-\d+\.ts)$/);
  if (!match || req.method !== 'GET') return false;

  const job = jobs.get(match[1]);
  if (!job) {
    sendJson(res, 404, { error: 'This playback session has expired.' });
    return true;
  }

  const filename = match[2];
  const filePath = path.join(job.outputDir, filename);
  if (!filePath.startsWith(job.outputDir) || !fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'The requested HLS file is not ready.' });
    return true;
  }

  job.lastAccessAt = Date.now();
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType(filename),
    'Content-Length': stat.size,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': filename.endsWith('.m3u8') ? 'no-store' : 'public, max-age=86400, immutable',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400'
      });
      return res.end();
    }

    if (serveHls(pathname, req, res)) return;

    if ((pathname === '/' || pathname === '/health') && req.method === 'GET') {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'sny-stream-transcoder',
        version: '1.2.0',
        ffmpeg: true,
        audioGuard: 'english-preferred-with-selector',
        activeJobs: activeJobCount(),
        maxActiveJobs: MAX_ACTIVE_JOBS
      });
    }

    if (!pathname.startsWith('/v1/') || !isAuthorised(req)) {
      return sendJson(res, 401, { error: 'Unauthorised.', code: 'UNAUTHORISED' });
    }

    if (pathname === '/v1/probe' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const validatedUrl = await validateSourceUrl(body.sourceUrl);
      const probe = await probeSource(validatedUrl);
      if (!probe.probeError) assertEnglishPreferredAudio(probe.audioAnalysis);
      return sendJson(res, 200, publicProbePayload(probe));
    }

    if (pathname === '/v1/jobs' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await createJob(body);
      return sendJson(res, 201, result);
    }

    const jobMatch = pathname.match(/^\/v1\/jobs\/([A-Za-z0-9_-]{16,80})$/);
    if (jobMatch && req.method === 'DELETE') {
      const job = jobs.get(jobMatch[1]);
      if (!job) return sendJson(res, 200, { stopped: false });
      removeJob(job);
      return sendJson(res, 200, { stopped: true });
    }

    if (jobMatch && req.method === 'GET') {
      const job = jobs.get(jobMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'Job not found.' });
      return sendJson(res, 200, {
        ...jobPublicPayload(job),
        error: job.error,
        createdAt: new Date(job.createdAt).toISOString(),
        readyAt: job.readyAt ? new Date(job.readyAt).toISOString() : null
      });
    }

    return sendJson(res, 404, { error: 'Route not found.' });
  } catch (error) {
    console.error('[transcoder]', error);
    return sendJson(res, Number(error?.statusCode) || 500, {
      error: error?.message || 'Internal transcoder error.',
      code: error?.code || 'TRANSCODER_ERROR',
      retryable: error?.retryable !== false
    });
  }
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (now - job.lastAccessAt > JOB_TTL_MS) removeJob(job);
  }
  for (const [key, cached] of probeCache.entries()) {
    if (!cached || cached.expiresAt <= now) probeCache.delete(key);
  }
}, 60_000);
cleanupTimer.unref?.();

server.listen(PORT, HOST, () => {
  if (SECRET.length < 24) {
    console.error('TRANSCODER_SECRET must contain at least 24 characters.');
  }
  console.log(`SNY Stream transcoder listening on [${HOST}]:${PORT}`);
  console.log(`Work directory: ${WORK_ROOT}`);
  console.log(`Maximum active jobs: ${MAX_ACTIVE_JOBS}`);
});

function shutdown(signal) {
  console.log(`${signal} received. Stopping transcoder jobs...`);
  clearInterval(cleanupTimer);
  for (const job of jobs.values()) removeJob(job);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref?.();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
