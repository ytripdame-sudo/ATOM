/**
 * The pure half of the wallpaper engine: what a file is, what the options mean,
 * and how often a frame may be drawn. No DOM here, so node can test it; the
 * renderer next door is the only thing that paints.
 */

export const MAX_FILE_BYTES = 48 * 1024 * 1024;
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export const PRESETS = [
  { id: 'flow', name: 'Flow', hint: 'Two colours drifting' },
  { id: 'blobs', name: 'Liquid', hint: 'Soft floating light' },
  { id: 'particles', name: 'Dust', hint: 'Specks in the dark' },
];

export const DEFAULT_OPTIONS = {
  opacity: 1,
  dim: 0.35,
  blur: 0,
  speed: 1,
  volume: 0,
  muted: true,
  fps: 30,
  lowPower: false,
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|m4v|mov|ogv)$/i;
const HTML_EXT = /\.html?$/i;

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function detectKind(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '');
  if (type === 'text/html' || HTML_EXT.test(name)) return 'html';
  if (type.startsWith('video/') || VIDEO_EXT.test(name)) return 'video';
  if (type.startsWith('image/') || IMAGE_EXT.test(name)) return 'image';
  return '';
}

export function checkFile(file) {
  const kind = detectKind(file);
  if (!kind) return { ok: false, reason: 'Only images, videos and .html files can be a wallpaper.' };

  const limit = kind === 'html' ? MAX_HTML_BYTES : MAX_FILE_BYTES;
  if (file.size > limit) {
    const megabytes = Math.round(file.size / 1048576);
    return { ok: false, reason: `${file.name} is ${megabytes} MB; the limit is ${Math.round(limit / 1048576)} MB.` };
  }

  return { ok: true, kind };
}

export function normalizeOptions(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    opacity: clampNumber(source.opacity, 0.05, 1, DEFAULT_OPTIONS.opacity),
    dim: clampNumber(source.dim, 0, 0.95, DEFAULT_OPTIONS.dim),
    blur: clampNumber(source.blur, 0, 24, DEFAULT_OPTIONS.blur),
    speed: clampNumber(source.speed, 0.25, 2, DEFAULT_OPTIONS.speed),
    volume: clampNumber(source.volume, 0, 1, DEFAULT_OPTIONS.volume),
    muted: source.muted !== false,
    fps: [15, 24, 30, 60].includes(Number(source.fps)) ? Number(source.fps) : DEFAULT_OPTIONS.fps,
    lowPower: source.lowPower === true,
  };
}

export function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(source.items)
    ? source.items
        .filter((item) => item && typeof item.id === 'string' && ['image', 'video', 'html'].includes(item.kind))
        .slice(0, 60)
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          name: String(item.name || 'Wallpaper').slice(0, 80),
          mime: String(item.mime || ''),
        }))
    : [];

  const ids = new Set(items.map((item) => item.id));
  const presets = new Set(PRESETS.map((preset) => `preset:${preset.id}`));
  const activeId = typeof source.activeId === 'string' ? source.activeId : '';
  const keep = ids.has(activeId) || presets.has(activeId);

  return { items, activeId: keep ? activeId : 'preset:flow', options: normalizeOptions(source.options) };
}

/** True at most `target` times a second: the frame cap, without a timer. */
export function createFpsGate(target) {
  const step = 1000 / clampNumber(target, 1, 120, DEFAULT_OPTIONS.fps);
  let last = -Infinity;

  return (now) => {
    if (now - last < step - 1) return false;
    last = now;
    return true;
  };
}
