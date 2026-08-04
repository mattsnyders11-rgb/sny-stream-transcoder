import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function isPrivateIpv6(address) {
  const normalised = address.toLowerCase();
  return normalised === '::'
    || normalised === '::1'
    || normalised.startsWith('fc')
    || normalised.startsWith('fd')
    || normalised.startsWith('fe8')
    || normalised.startsWith('fe9')
    || normalised.startsWith('fea')
    || normalised.startsWith('feb')
    || normalised.startsWith('::ffff:127.')
    || normalised.startsWith('::ffff:10.')
    || normalised.startsWith('::ffff:192.168.')
    || normalised.startsWith('::ffff:169.254.');
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export function verifySharedSecret(req) {
  const configured = String(process.env.TRANSCODER_SECRET || '');
  const supplied = String(req.headers['x-sny-transcoder-secret'] || '');
  if (configured.length < 24 || supplied.length !== configured.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(configured));
}

export async function validateSourceUrl(value) {
  const allowPrivateSources = String(process.env.ALLOW_PRIVATE_SOURCE_URLS || '').toLowerCase() === 'true';
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('The source URL is invalid.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS media sources are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Media URLs containing embedded credentials are not accepted.');
  }
  if (!parsed.hostname || (!allowPrivateSources && parsed.hostname.toLowerCase() === 'localhost')) {
    throw new Error('Localhost media sources are not accepted.');
  }

  const literalFamily = net.isIP(parsed.hostname);
  if (!allowPrivateSources && literalFamily && isPrivateAddress(parsed.hostname)) {
    throw new Error('Private-network media sources are not accepted.');
  }

  if (!allowPrivateSources && !literalFamily) {
    const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) {
      throw new Error('The media hostname resolves to a private or reserved address.');
    }
  }

  return parsed.toString();
}

export function createPlaybackToken(jobId) {
  const secret = String(process.env.TRANSCODER_SECRET || '');
  return crypto.createHmac('sha256', secret).update(jobId).digest('base64url');
}

export function verifyPlaybackToken(jobId, token) {
  const expected = createPlaybackToken(jobId);
  const supplied = String(token || '');
  if (!supplied || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
