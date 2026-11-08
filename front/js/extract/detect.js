// Client-side file type detection.
//
// This is a fast guard so we can reject unsupported files before doing any
// work. It is NOT a security boundary: the server re-validates the declared
// type and the real file content.

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
// CSV/TSV are plain text: the CV ATS spec accepts a CV exported as .csv, so
// they are read as text instead of being rejected like binary spreadsheets.
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'tsv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';

// Spreadsheets are a CotizaIA feature, not a scan feature. Only the BINARY
// formats stay here: a .csv/.tsv is plain text and is accepted as a CV by
// this product (spec 04), so it must reach the text branch below instead of
// being silently rejected.
const SPREADSHEET_MIMES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx']);

/**
 * @typedef {'image'|'pdf'|'docx'|'text'|'doc'|'audio'|'spreadsheet'|'unknown'} DetectedType
 */

/**
 * @param {File} file
 * @returns {{ type: DetectedType, mime: string, ext: string }}
 */
export function detectType(file) {
  const name = String((file && file.name) || '').toLowerCase();
  const mime = String((file && file.type) || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';

  // Legacy .doc is explicitly rejected: OLE2 binary, no browser parser.
  if (mime === DOC_MIME || ext === 'doc') {
    return { type: 'doc', mime, ext };
  }

  if (mime === 'application/pdf' || ext === 'pdf') {
    return { type: 'pdf', mime, ext };
  }

  if (mime === DOCX_MIME || ext === 'docx') {
    return { type: 'docx', mime, ext };
  }

  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) {
    return { type: 'image', mime, ext };
  }

  // Spreadsheets: rejected here (they belong to CotizaIA).
  if (SPREADSHEET_MIMES.has(mime) || SPREADSHEET_EXTENSIONS.has(ext)) {
    return { type: 'spreadsheet', mime, ext };
  }

  if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) {
    return { type: 'text', mime, ext };
  }

  // Audio files: mp3, wav, ogg, m4a, flac, webm
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) {
    return { type: 'audio', mime, ext };
  }

  return { type: 'unknown', mime, ext };
}