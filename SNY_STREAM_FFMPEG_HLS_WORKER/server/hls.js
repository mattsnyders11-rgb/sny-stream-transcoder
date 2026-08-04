function withPlaybackToken(value, token) {
  const uri = String(value || '').trim();
  if (!uri) return uri;
  const separator = uri.includes('?') ? '&' : '?';
  return `${uri}${separator}token=${encodeURIComponent(token)}`;
}

export function rewritePlaylist(text, token) {
  return String(text || '').split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // fMP4 HLS playlists reference the initialization file from an attribute
    // on EXT-X-MAP rather than from a standalone URI line. It needs the same
    // signed token as media segments.
    if (trimmed.startsWith('#EXT-X-MAP:') || trimmed.startsWith('#EXT-X-KEY:')) {
      return line.replace(/URI="([^"]+)"/i, (_match, uri) => {
        return `URI="${withPlaybackToken(uri, token)}"`;
      });
    }

    if (trimmed.startsWith('#')) return line;
    return withPlaybackToken(trimmed, token);
  }).join('\n');
}

export function isAllowedHlsFilename(filename) {
  return filename === 'index.m3u8'
    || filename === 'init.mp4'
    || /^segment_\d{6}\.(?:m4s|ts)$/.test(filename);
}

export function hlsContentType(filename) {
  if (filename.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (filename.endsWith('.mp4')) return 'video/mp4';
  if (filename.endsWith('.m4s')) return 'video/iso.segment';
  if (filename.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}
