// Google-style identity for chats and the profile panel: the photo when the
// person has one, a two-letter initials circle otherwise. Shared by
// chat-widget.js (own messages), admin.js (conversation thread) and app.js
// (profile panel).
//
// The circle is always a <span> carrying background-color and, when present,
// background-image: a photo URL that stops resolving simply leaves the
// colored circle with a broken image hidden behind it — never a
// broken-image glyph. Sizes are static Tailwind classes because the CDN JIT
// only generates classes it can observe in the DOM.

const PALETTE = [
  '#DB4437', // red
  '#F4B400', // yellow
  '#0F9D58', // green
  '#4285F4', // blue
  '#AB47BC', // purple
  '#00ACC1', // teal
  '#FF7043', // orange
  '#5C6BC0', // indigo
];

const SIZES = {
  sm: 'h-6 w-6 text-[10px]', // 24 px — thread rows and chat bubbles
  md: 'h-8 w-8 text-xs', // 32 px — default
  lg: 'h-16 w-16 text-xl', // 64 px — profile panel
};

/**
 * Two display letters: first letters of the two first words (Ana López -> AL),
 * or the first two letters of a single word (Ana -> AN). Accents are stripped
 * so "É" does not render as a combining pair.
 *
 * @param {string} name
 * @returns {string}
 */
export function initialsOf(name) {
  const clean = String(name || '').trim();

  if (clean === '') {
    return '?';
  }

  const strip = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = clean.split(/\s+/).filter((word) => word !== '');

  let letters;
  if (words.length >= 2) {
    letters = strip(words[0]).charAt(0) + strip(words[1]).charAt(0);
  } else {
    letters = strip(words[0]).slice(0, 2);
  }

  letters = letters.toUpperCase();

  // Scripts without case (CJK, emoji): the first character still reads well.
  return letters === '' ? clean.charAt(0).toUpperCase() : letters;
}

/**
 * Deterministic palette color from a stable seed (id > email > name), so the
 * same person keeps the same circle everywhere.
 *
 * @param {string} seed
 * @returns {string}
 */
export function colorOf(seed) {
  const text = String(seed || '');
  let hash = 0;

  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }

  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/**
 * Identity circle element. Pass `{ name, id, avatar }` (avatar = URL or null).
 *
 * @param {{ name?: string, id?: string, email?: string, avatar?: string|null }} user
 * @param {'sm'|'md'|'lg'} [size]
 * @returns {HTMLSpanElement}
 */
export function avatarNode(user, size = 'md') {
  const box = SIZES[size] || SIZES.md;
  const name = user && user.name ? String(user.name) : '';
  const node = document.createElement('span');

  node.className =
    'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none text-white ' + box;
  node.style.backgroundColor = colorOf((user && (user.id || user.email)) || name);
  node.style.backgroundSize = 'cover';
  node.style.backgroundPosition = 'center';
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', name !== '' ? 'Foto de ' + name : 'Foto de perfil');

  if (name !== '') {
    node.title = name;
    node.textContent = initialsOf(name);
  }

  const avatar = user && user.avatar ? String(user.avatar) : '';

  if (avatar !== '') {
    node.textContent = '';
    node.style.backgroundImage = 'url("' + avatar.replace(/"/g, '%22') + '")';
  }

  return node;
}

/**
 * Same circle as an HTML string (for templates rendered with innerHTML).
 *
 * @param {{ name?: string, id?: string, email?: string, avatar?: string|null }} user
 * @param {'sm'|'md'|'lg'} [size]
 * @returns {string}
 */
export function avatarHtml(user, size = 'md') {
  return avatarNode(user, size).outerHTML;
}

/**
 * Assistant identity circle. With a URL it is the uploaded image (same
 * background-image circle as avatarNode); without one, the default: a blue
 * circle with a small white robot glyph. Pure decoration — always aria-hidden
 * (the surrounding row already carries the message content).
 *
 * @param {string|null} [url]
 * @param {'sm'|'md'|'lg'} [size]
 * @returns {HTMLSpanElement}
 */
export function botAvatarNode(url = null, size = 'sm') {
  const box = SIZES[size] || SIZES.sm;
  const node = document.createElement('span');

  node.className =
    'inline-flex shrink-0 select-none items-center justify-center rounded-full bg-blue-600 ' + box;
  node.style.backgroundSize = 'cover';
  node.style.backgroundPosition = 'center';
  node.setAttribute('aria-hidden', 'true');

  const image = url ? String(url) : '';

  if (image !== '') {
    node.style.backgroundImage = 'url("' + image.replace(/"/g, '%22') + '")';
  } else {
    // Default glyph: inline style (never JIT classes) so it scales with the
    // circle at any size.
    node.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" style="width:55%;height:55%" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2" aria-hidden="true"><rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 8V4M9 13h.01M15 13h.01M9 16.5h6"/></svg>';
  }

  return node;
}

/**
 * Same assistant circle as an HTML string (for templates rendered with
 * innerHTML).
 *
 * @param {string|null} [url]
 * @param {'sm'|'md'|'lg'} [size]
 * @returns {string}
 */
export function botAvatarHtml(url = null, size = 'sm') {
  return botAvatarNode(url, size).outerHTML;
}
