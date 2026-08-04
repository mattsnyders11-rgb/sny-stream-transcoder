import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createPlaybackToken, validateSourceUrl } from './security.js';

const ROOT_DIR = path.resolve(process.env.TRANSCODE_DIR || '/tmp/sny-transcoder');
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS) || 1);
const IDLE_TTL_MS = Math.max(60, Number(process.env.JOB_IDLE_TTL_SECONDS) || 300) * 1000;
const STARTUP_TIMEOUT_MS = Math.max(20, Number(process.env.JOB_STARTUP_TIMEOUT_SECONDS) || 75) * 1000;
const MAX_HEIGHT = Math.min(2160, Math.max(360, Number(process.env.TRANSCODE_MAX_HEIGHT) || 1080));
const VIDEO_BITRATE = String(process.env.TRANSCODE_VIDEO_BITRATE || '5000k');
const AUDIO_BITRATE = String(process.env.TRANSCODE_AUDIO_BITRATE || '160k');
const PRESET = String(process.env.TRANSCODE_PRESET || 'veryfast');
const PUBLIC_URL = String(process.env.TRANSCODER_PUBLIC_URL || '').replace(/\/+$/, '');
const jobs = new Map();

function activeJobCount() {
  return [...jobs.values()].filter(job => !['stopped', 'failed', 'complete'].includes(job.state)).length;
}

function appendLog(job, chunk) {
  const text = String(chunk || '');
  job.stderr = `${job.stderr}${text}`.slice(-12_000);
}

function safeRemoveDirectory(directory) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
}

export function buildFfmpegArgs(sourceUrl, outputDirectory, startSeconds) {
  const segmentPattern = path.join(outputDirectory, 'segment_%06d.m4s');
  const playlistPath = path.join(outputDirectory, 'index.m3u8');
  const scaleFilter = [
    `scale=w=-2:h='min(${MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
    'fps=30:round=near',
    'setsar=1',
    'format=yuv420p'
  ].join(',');

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    '-y',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5'
  ];

  if (startSeconds > 0) args.push('-ss', String(startSeconds));

  args.push(
    '-i', sourceUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    '-vf', scaleFilter,
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-profile:v', 'high',
    '-level:v', '4.1',
    '-pix_fmt', 'yuv420p',
    '-b:v', VIDEO_BITRATE,
    '-maxrate', VIDEO_BITRATE,
    '-bufsize', '10000k',
    '-g', '60',
    '-keyint_min', '60',
    '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-c:a', 'aac',
    '-profile:a', 'aac_low',
    '-b:a', AUDIO_BITRATE,
    '-ac', '2',
    '-ar', '48000',
    '-af', 'aresample=async=1:first_pts=0',
    '-max_muxing_queue_size', '2048',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', segmentPattern,
    playlistPath
  );

  return args;
}

function waitForPlaylist(job) {
  const playlistPath = path.join(job.directory, 'index.m3u8');
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (job.state === 'failed' || job.state === 'stopped') {
        clearInterval(timer);
        reject(new Error(job.error || 'The transcoder stopped before producing video.'));
        return;
      }

      try {
        const playlist = fs.readFileSync(playlistPath, 'utf8');
        if (
          playlist.includes('#EXT-X-MAP:URI="init.mp4"')
          && playlist.includes('#EXTINF:')
          && /segment_\d+\.m4s/.test(playlist)
        ) {
          clearInterval(timer);
          job.state = 'ready';
          job.readyAt = Date.now();
          resolve();
          return;
        }
      } catch {}

      if (Date.now() - startedAt > STARTUP_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error('FFmpeg did not produce the first HLS segment in time.'));
      }
    }, 250);
    timer.unref?.();
  });
}

export function getWorkerStatus() {
  return {
    activeJobs: activeJobCount(),
    totalJobs: jobs.size,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    maxHeight: MAX_HEIGHT,
    output: 'HLS fMP4 / H.264 High 4.1 / AAC-LC stereo',
    segmentSeconds: 2,
    pixelFormat: 'yuv420p',
    maxFrameRate: 30
  };
}

export async function createJob({ sourceUrl, startSeconds = 0 }) {
  if (!PUBLIC_URL) {
    const error = new Error('TRANSCODER_PUBLIC_URL is not configured.');
    error.statusCode = 503;
    throw error;
  }
  if (activeJobCount() >= MAX_CONCURRENT_JOBS) {
    const error = new Error('The compatibility server is currently busy. Try again shortly.');
    error.statusCode = 429;
    throw error;
  }

  const validatedUrl = await validateSourceUrl(sourceUrl);
  const safeStartSeconds = Math.min(86_400, Math.max(0, Number(startSeconds) || 0));
  const id = crypto.randomBytes(18).toString('base64url');
  const directory = path.join(ROOT_DIR, id);
  fs.mkdirSync(directory, { recursive: true });

  const job = {
    id,
    directory,
    sourceUrl: validatedUrl,
    startSeconds: safeStartSeconds,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    readyAt: null,
    state: 'starting',
    stderr: '',
    error: null,
    process: null
  };
  jobs.set(id, job);

  const args = buildFfmpegArgs(validatedUrl, directory, safeStartSeconds);
  const child = spawn('ffmpeg', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
  job.process = child;
  child.stderr.on('data', chunk => appendLog(job, chunk));
  child.once('error', error => {
    job.state = 'failed';
    job.error = error.message;
  });
  child.once('exit', (code, signal) => {
    job.process = null;
    if (job.state === 'stopped') return;
    if (code === 0) {
      job.state = 'complete';
      return;
    }
    job.state = 'failed';
    job.error = `FFmpeg stopped with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`;
  });

  try {
    await waitForPlaylist(job);
  } catch (error) {
    await stopJob(id);
    const wrapped = new Error(`${error.message}${job.stderr ? ` ${job.stderr.slice(-800)}` : ''}`.trim());
    wrapped.statusCode = 502;
    throw wrapped;
  }

  const token = createPlaybackToken(id);
  return {
    jobId: id,
    hlsUrl: `${PUBLIC_URL}/hls/${encodeURIComponent(id)}/index.m3u8?token=${encodeURIComponent(token)}`,
    state: job.state,
    output: 'HLS fMP4 + H.264 High 4.1 + AAC-LC stereo',
    maxHeight: MAX_HEIGHT,
    startSeconds: safeStartSeconds
  };
}

export function getJob(jobId) {
  const job = jobs.get(jobId);
  if (job) job.lastAccessAt = Date.now();
  return job || null;
}

export async function stopJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.state = 'stopped';
  if (job.process && !job.process.killed) {
    job.process.kill('SIGTERM');
    setTimeout(() => {
      if (job.process && !job.process.killed) job.process.kill('SIGKILL');
    }, 3_000).unref();
  }
  jobs.delete(jobId);
  safeRemoveDirectory(job.directory);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (now - job.lastAccessAt > IDLE_TTL_MS) {
      stopJob(job.id).catch(() => {});
    }
  }
}, 30_000).unref();

fs.mkdirSync(ROOT_DIR, { recursive: true });
