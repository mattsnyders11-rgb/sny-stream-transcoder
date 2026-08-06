const ENGLISH_CODES = new Set([
  'en', 'eng', 'en-us', 'en-gb', 'en-au', 'en-ca', 'english'
]);

const UNKNOWN_CODES = new Set([
  '', 'und', 'unk', 'unknown', 'mis', 'mul', 'zxx', 'n/a', 'na'
]);

const COMMENTARY_PATTERN = /\b(commentary|director(?:'s)?\s+commentary|cast\s+commentary|crew\s+commentary)\b/i;
const DESCRIPTION_PATTERN = /\b(audio\s+description|descriptive\s+audio|described\s+video|visually\s+impaired|narration)\b/i;
const ENGLISH_TITLE_PATTERN = /(?:^|[\s._\-\[(])(?:english|eng)(?:$|[\s._\-\])])/i;

function cleanText(value) {
  return String(value || '').trim();
}

export function normaliseLanguageCode(value) {
  return cleanText(value)
    .toLowerCase()
    .replaceAll('_', '-')
    .replace(/^([a-z]{2,3})-.+$/, '$1');
}

export function describeAudioStream(stream = {}) {
  const tags = stream.tags && typeof stream.tags === 'object' ? stream.tags : {};
  const disposition = stream.disposition && typeof stream.disposition === 'object'
    ? stream.disposition
    : {};
  const rawLanguage = cleanText(tags.language || tags.LANGUAGE || '');
  const language = normaliseLanguageCode(rawLanguage);
  const title = cleanText(tags.title || tags.handler_name || tags.HANDLER_NAME || '');
  const combined = `${rawLanguage} ${title}`.trim();
  const isEnglish = ENGLISH_CODES.has(language) || ENGLISH_TITLE_PATTERN.test(combined);
  const languageKnown = !UNKNOWN_CODES.has(language);
  const isCommentary = COMMENTARY_PATTERN.test(combined) || Number(disposition.comment || 0) === 1;
  const isDescription = DESCRIPTION_PATTERN.test(combined)
    || Number(disposition.visual_impaired || 0) === 1
    || Number(disposition.descriptions || 0) === 1;
  const isDefault = Number(disposition.default || 0) === 1;
  const channels = Number(stream.channels) || 0;

  let score = 0;
  if (isEnglish) score += 1000;
  if (isDefault) score += 80;
  if (channels >= 6) score += 30;
  else if (channels >= 2) score += 15;
  if (isCommentary) score -= 700;
  if (isDescription) score -= 500;

  return {
    index: Number.isInteger(Number(stream.index)) ? Number(stream.index) : null,
    codec: cleanText(stream.codec_name) || null,
    channels: channels || null,
    channelLayout: cleanText(stream.channel_layout) || null,
    language: rawLanguage || null,
    normalisedLanguage: language || null,
    title: title || null,
    isEnglish,
    languageKnown,
    isDefault,
    isCommentary,
    isDescription,
    score,
    stream
  };
}

export function analyseAudioStreams(streams = []) {
  const audioStreams = (Array.isArray(streams) ? streams : [])
    .filter(stream => String(stream?.codec_type || '').toLowerCase() === 'audio')
    .map(describeAudioStream);

  if (!audioStreams.length) {
    return {
      status: 'no-audio',
      hasAudio: false,
      hasEnglish: false,
      hasKnownForeign: false,
      hasUnknownLanguage: false,
      selected: null,
      defaultAudioStreamIndex: null,
      tracks: []
    };
  }

  const defaultTrack = audioStreams.find(track => track.isDefault) || audioStreams[0];
  const ordinaryEnglish = audioStreams
    .filter(track => track.isEnglish && !track.isCommentary && !track.isDescription)
    .sort((a, b) => b.score - a.score || (a.index ?? 9999) - (b.index ?? 9999));
  const anyEnglish = audioStreams
    .filter(track => track.isEnglish)
    .sort((a, b) => b.score - a.score || (a.index ?? 9999) - (b.index ?? 9999));
  const unknownTracks = audioStreams.filter(track => !track.languageKnown);
  const knownForeignTracks = audioStreams.filter(track => track.languageKnown && !track.isEnglish);

  const selected = ordinaryEnglish[0]
    || anyEnglish[0]
    || (defaultTrack && !defaultTrack.languageKnown ? defaultTrack : null)
    || unknownTracks[0]
    || defaultTrack;

  let status = 'unknown';
  if (ordinaryEnglish.length || anyEnglish.length) status = 'english';
  else if (knownForeignTracks.length && !unknownTracks.length) status = 'foreign-only';

  return {
    status,
    hasAudio: true,
    hasEnglish: Boolean(ordinaryEnglish.length || anyEnglish.length),
    hasKnownForeign: Boolean(knownForeignTracks.length),
    hasUnknownLanguage: Boolean(unknownTracks.length),
    selected,
    defaultAudioStreamIndex: defaultTrack?.index ?? null,
    tracks: audioStreams
  };
}

function publicAudioTrack(track = {}) {
  return {
    streamIndex: Number.isInteger(track?.index) ? track.index : null,
    language: track?.language || null,
    normalisedLanguage: track?.normalisedLanguage || null,
    title: track?.title || null,
    codec: track?.codec || null,
    channels: Number(track?.channels) || null,
    channelLayout: track?.channelLayout || null,
    isEnglish: Boolean(track?.isEnglish),
    languageKnown: Boolean(track?.languageKnown),
    isDefault: Boolean(track?.isDefault),
    isCommentary: Boolean(track?.isCommentary),
    isDescription: Boolean(track?.isDescription)
  };
}

export function publicAudioAnalysis(analysis = {}) {
  const selected = analysis.selected || null;
  const tracks = Array.isArray(analysis.tracks)
    ? analysis.tracks.map(publicAudioTrack).filter(track => track.streamIndex !== null)
    : [];
  return {
    status: analysis.status || 'unverified',
    hasAudio: Boolean(analysis.hasAudio),
    hasEnglish: Boolean(analysis.hasEnglish),
    hasKnownForeign: Boolean(analysis.hasKnownForeign),
    hasUnknownLanguage: Boolean(analysis.hasUnknownLanguage),
    selectedStreamIndex: Number.isInteger(selected?.index) ? selected.index : null,
    defaultAudioStreamIndex: Number.isInteger(analysis.defaultAudioStreamIndex)
      ? analysis.defaultAudioStreamIndex
      : null,
    selectedLanguage: selected?.language || null,
    selectedTitle: selected?.title || null,
    selectedCodec: selected?.codec || null,
    selectedChannels: selected?.channels || null,
    selectedIsDefault: Boolean(selected?.isDefault),
    selectedIsCommentary: Boolean(selected?.isCommentary),
    selectedIsDescription: Boolean(selected?.isDescription),
    trackCount: tracks.length,
    tracks
  };
}

export function assertEnglishPreferredAudio(analysis = {}) {
  if (analysis.status === 'foreign-only') {
    const error = new Error('This source does not contain a confirmed English audio track. Trying the next source.');
    error.statusCode = 409;
    error.code = 'ENGLISH_AUDIO_NOT_AVAILABLE';
    error.retryable = true;
    throw error;
  }

  if (analysis.status === 'no-audio') {
    const error = new Error('This source does not contain an audio track. Trying the next source.');
    error.statusCode = 409;
    error.code = 'NO_AUDIO_TRACK';
    error.retryable = true;
    throw error;
  }

  return analysis;
}
