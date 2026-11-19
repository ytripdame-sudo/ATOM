/**
 * The wallpaper engine. One moving layer at a time — a canvas, an image, a
 * video or a sandboxed document — drawn in whichever layer is free, then faded
 * over the last one. The small state record lives in chrome.storage.local; the
 * files live in IndexedDB, because a video does not fit in extension storage.
 */
import { PRESETS, checkFile, createFpsGate, normalizeState } from './wallpaper-core.js';

const KEY = 'atom.wallpapers';
const DB_NAME = 'atom-wallpapers';
// Matches --dur-3, the crossfade in newtab.css.
const FADE_MS = 420;

const wall = document.getElementById('wall');
const tint = document.getElementById('wallTint');
const sheet = document.getElementById('wallSheet');
const openButton = document.getElementById('wallBtn');
const closeButton = document.getElementById('wallClose');
const grid = document.getElementById('wallGrid');
const fileInput = document.getElementById('wallFiles');
const statusLine = document.getElementById('wallStatus');
const layers = [document.getElementById('wallA'), document.getElementById('wallB')];

const controls = {
  opacity: document.getElementById('wallOpacity'),
  dim: document.getElementById('wallDim'),
  blur: document.getElementById('wallBlur'),
  speed: document.getElementById('wallSpeed'),
  fps: document.getElementById('wallFps'),
  volume: document.getElementById('wallVolume'),
  mute: document.getElementById('wallMute'),
  lowPower: document.getElementById('wallLowPower'),
};

/** The graphics mode, written on <html> by perf.js — the CSS reads it too. */
const perf = () => document.documentElement.dataset.perf === 'performance';

let state = normalizeState(null);
let front = 0;
let current = null;
let tileUrls = [];
let dbPromise = null;

/* --------------------------------------------------------------- storage */

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function ask(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function fileStore(mode) {
  const database = await openDb();
  return database.transaction('files', mode).objectStore('files');
}

const getFile = async (id) => ask((await fileStore('readonly')).get(id));
const putFile = async (id, blob) => ask((await fileStore('readwrite')).put(blob, id));
const delFile = async (id) => ask((await fileStore('readwrite')).delete(id));

async function readState() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return stored?.[KEY];
  } catch {
    return null;
  }
}

function saveState() {
  return chrome.storage.local.set({ [KEY]: state }).catch(() => {});
}

/* ---------------------------------------------------------------- render */

async function prepare(id) {
  if (typeof id !== 'string' || !id) return null;

  if (id.startsWith('preset:')) {
    const preset = PRESETS.find((entry) => `preset:${entry.id}` === id);
    return preset ? presetRenderer(preset) : null;
  }

  const item = state.items.find((entry) => entry.id === id);
  if (!item) return null;

  const blob = await getFile(item.id).catch(() => null);
  if (!blob) return null;

  if (item.kind === 'html') {
    const html = await blob.text().catch(() => '');
    return html ? htmlRenderer(html) : null;
  }

  const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob], { type: item.mime }));
  if (item.kind === 'video') return videoRenderer(url);
  return imageRenderer(url);
}

async function imageRenderer(url) {
  const image = new Image();
  image.alt = '';
  image.decoding = 'async';
  image.src = url;
  await image.decode().catch(() => {});

  // Performance mode gets a still frame as pixels: a GIF cannot be paused any
  // other way, and a canvas costs nothing to keep still.
  if (perf()) {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || 1;
    canvas.height = image.naturalHeight || 1;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    return { node: canvas, kind: 'image', urls: [url] };
  }

  return { node: image, kind: 'image', urls: [url] };
}

function videoRenderer(url) {
  const video = document.createElement('video');
  video.src = url;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  const play = () => {
    if (document.hidden || state.options.lowPower || perf()) return;
    video.play().catch(() => {});
  };
  video.addEventListener('loadeddata', play, { once: true });

  return {
    node: video,
    kind: 'video',
    urls: [url],
    apply(options) {
      video.muted = options.muted;
      video.volume = options.volume;
      video.playbackRate = options.speed;
      if (options.lowPower || perf()) video.pause();
      else play();
    },
    pause: () => video.pause(),
    resume: play,
    stop() {
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
}

function htmlRenderer(html) {
  // The document is posted into a manifest sandbox page rather than loaded from
  // a blob: a blob would inherit this page's CSP and lose the wallpaper's own
  // scripts, which is most of what an HTML wallpaper is.
  const frame = document.createElement('iframe');
  frame.setAttribute('allow', 'autoplay');
  frame.setAttribute('title', 'Wallpaper');

  const post = (message) => frame.contentWindow?.postMessage(message, '*');

  const sendParams = (options) => {
    post({ type: 'atom-wall-params', params: { muted: options.muted, volume: options.volume, speed: options.speed } });
    post({ type: 'atom-wall-pause', paused: Boolean(options.lowPower) || document.hidden || perf() });
  };

  const onMessage = (event) => {
    if (event.source !== frame.contentWindow) return;
    if (event.data?.type !== 'atom-wall-ready') return;
    post({ type: 'atom-wall-html', html });
    sendParams(state.options);
  };

  // Listen first: the frame announces itself as soon as it loads.
  addEventListener('message', onMessage);
  frame.src = chrome.runtime.getURL('newtab/wall-frame.html');

  return {
    node: frame,
    kind: 'html',
    urls: [],
    apply: sendParams,
    pause: () => post({ type: 'atom-wall-pause', paused: true }),
    resume: () => post({ type: 'atom-wall-pause', paused: Boolean(state.options.lowPower) }),
    stop() {
      removeEventListener('message', onMessage);
      frame.removeAttribute('src');
    },
  };
}

function presetRenderer(preset) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const paint = PRESET_PAINT[preset.id];
  // Gradients survive being upscaled; pixels cost four times as much.
  const scale = 0.5;

  let running = false;
  let raf = 0;
  let clock = 0;
  let last = 0;
  let gate = createFpsGate(state.options.fps);

  const resize = () => {
    canvas.width = Math.max(2, Math.round((innerWidth || 1280) * scale));
    canvas.height = Math.max(2, Math.round((innerHeight || 720) * scale));
    paint(ctx, canvas.width, canvas.height, clock / 1000);
  };

  const frame = (now) => {
    if (!running) return;
    const delta = last ? Math.min(64, now - last) : 16;
    last = now;
    if (gate(now)) {
      clock += delta * state.options.speed;
      paint(ctx, canvas.width, canvas.height, clock / 1000);
    }
    raf = requestAnimationFrame(frame);
  };

  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
    raf = 0;
  };

  const start = () => {
    stop();
    resize();
    if (state.options.lowPower || perf()) return;
    running = true;
    last = 0;
    gate = createFpsGate(state.options.fps);
    raf = requestAnimationFrame(frame);
  };

  addEventListener('resize', resize, { passive: true });
  start();

  return {
    node: canvas,
    kind: 'preset',
    urls: [],
    pause: stop,
    resume: start,
    apply() {},
    stop() {
      stop();
      removeEventListener('resize', resize);
    },
  };
}

async function show(id, { instant = false } = {}) {
  const renderer = await prepare(id);
  if (!renderer) return;

  const incoming = layers[front ^ 1];
  const outgoing = layers[front];
  const previous = current;

  incoming.replaceChildren(renderer.node);
  incoming.dataset.kind = renderer.kind;
  incoming.classList.remove('is-in');

  if (instant) {
    incoming.classList.add('is-in');
  } else {
    // A beat later, so the transition has a start value even in a hidden tab
    // where requestAnimationFrame never runs.
    setTimeout(() => incoming.classList.add('is-in'), 24);
  }

  outgoing.classList.remove('is-in');
  front ^= 1;
  current = renderer;
  previous?.stop?.();
  applyOptions();

  const settle = () => {
    if (outgoing.classList.contains('is-in')) return;
    outgoing.replaceChildren();
    for (const url of previous?.urls || []) URL.revokeObjectURL(url);
  };

  if (instant) settle();
  else setTimeout(settle, FADE_MS + 60);
}

/* --------------------------------------------------------------- presets */

const PRESET_PAINT = {
  flow(ctx, width, height, time) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#070a12';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';

    const blobs = [
      [0.5 + Math.sin(time * 0.19) * 0.28, 0.4 + Math.cos(time * 0.13) * 0.22, 'rgba(90, 96, 246, 0.55)'],
      [0.42 + Math.cos(time * 0.11) * 0.3, 0.62 + Math.sin(time * 0.17) * 0.2, 'rgba(46, 200, 168, 0.42)'],
      [0.58 + Math.sin(time * 0.07 + 1.2) * 0.26, 0.3 + Math.cos(time * 0.09 + 0.6) * 0.18, 'rgba(228, 92, 190, 0.3)'],
    ];
    const radius = Math.max(width, height) * 0.55;

    for (const [x, y, colour] of blobs) {
      const gradient = ctx.createRadialGradient(x * width, y * height, 0, x * width, y * height, radius);
      gradient.addColorStop(0, colour);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
  },

  blobs(ctx, width, height, time) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#06070d';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';

    const colours = ['rgba(120, 110, 255, 0.5)', 'rgba(72, 200, 255, 0.4)', 'rgba(255, 110, 200, 0.32)'];
    const radius = Math.min(width, height) * 0.34;

    for (let index = 0; index < 5; index += 1) {
      const phase = index * 1.7;
      const x = (0.5 + Math.sin(time * (0.08 + index * 0.012) + phase) * 0.32) * width;
      const y = (0.5 + Math.cos(time * (0.07 + index * 0.014) + phase) * 0.3) * height;
      const grow = 1 + Math.sin(time * 0.25 + phase) * 0.12;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * grow);
      gradient.addColorStop(0, colours[index % colours.length]);
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
  },

  particles(ctx, width, height, time) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';

    for (let index = 0; index < 90; index += 1) {
      const seed = ((index * 9301 + 49297) % 233280) / 233280;
      const seed2 = ((index * 233 + 97) % 981) / 981;
      const x = ((seed + time * 0.01 * (1 + seed2 * 2)) % 1) * width;
      const y = ((seed2 + time * 0.006 * (1 + seed)) % 1) * height;
      const alpha = Math.max(0.05, 0.16 + Math.sin(time * 0.6 + index) * 0.1);
      ctx.fillStyle = `rgba(180, 205, 255, ${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, 1 + seed2 * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  },
};

/* ------------------------------------------------------------------ grid */

function renderGrid() {
  releaseTileUrls();
  const nodes = PRESETS.map((preset) => tile(`preset:${preset.id}`, preset.name, 'preset'));
  for (const item of state.items) nodes.push(tile(item.id, item.name, item.kind));
  grid.replaceChildren(...nodes);
}

function tile(id, name, kind) {
  const node = document.createElement('div');
  node.className = 'walltile';
  node.dataset.id = id;
  node.dataset.kind = kind;
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-pressed', String(id === state.activeId));
  node.title = kind === 'preset' ? 'Built-in' : 'Double-click to rename';

  const peek = document.createElement('span');
  peek.className = 'walltile__peek';
  if (kind === 'html') peek.classList.add('walltile__peek--html');

  const label = document.createElement('span');
  label.className = 'walltile__name';
  label.textContent = name;

  node.append(peek, label);
  node.addEventListener('click', () => select(id));
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select(id);
  });

  if (kind !== 'preset') {
    node.addEventListener('dblclick', () => renameItem(id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'walltile__x';
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeItem(id);
    });
    node.append(remove);
    fillPeek(peek, id, kind);
  }

  return node;
}

async function fillPeek(peek, id, kind) {
  const blob = await getFile(id).catch(() => null);
  if (!blob || !peek.isConnected) return;

  const url = URL.createObjectURL(blob);
  tileUrls.push(url);

  if (kind === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.preload = 'metadata';
    peek.append(video);
    return;
  }

  if (kind === 'image') {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.src = url;
    peek.append(image);
  }
}

function releaseTileUrls() {
  for (const url of tileUrls) URL.revokeObjectURL(url);
  tileUrls = [];
}

function markActive() {
  for (const node of grid.children) node.setAttribute('aria-pressed', String(node.dataset.id === state.activeId));
}

async function select(id) {
  if (id !== state.activeId || !current) {
    state.activeId = id;
    await saveState();
    await show(id);
  }
  markActive();
}

async function renameItem(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;

  const name = prompt('Name this wallpaper', item.name);
  if (!name) return;

  item.name = name.slice(0, 80);
  await saveState();
  renderGrid();
}

async function removeItem(id) {
  state.items = state.items.filter((entry) => entry.id !== id);
  await delFile(id).catch(() => {});

  const wasActive = state.activeId === id;
  if (wasActive) state.activeId = 'preset:flow';
  await saveState();

  if (wasActive) await show(state.activeId, { instant: true });
  renderGrid();
}

async function importFiles() {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (!files.length) return;

  const notes = [];

  for (const file of files) {
    const checked = checkFile(file);
    if (!checked.ok) {
      notes.push(checked.reason);
      continue;
    }
    if (state.items.length >= 60) {
      notes.push('That is 60 wallpapers already; remove one first.');
      break;
    }

    const id = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      await putFile(id, file);
    } catch {
      notes.push(`${file.name} could not be stored.`);
      continue;
    }

    state.items.push({
      id,
      kind: checked.kind,
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 80),
      mime: file.type,
    });
    notes.push(`${file.name} added.`);
  }

  await saveState();
  renderGrid();
  statusLine.textContent = notes.join(' ');
}

/* --------------------------------------------------------------- options */

function applyOptions() {
  const options = state.options;
  const blur = perf() ? 0 : options.blur;

  wall.style.opacity = String(options.opacity);
  tint.style.opacity = String(options.dim);

  for (const layer of layers) {
    layer.style.filter = blur > 0 ? `blur(${blur}px)` : '';
    layer.style.transform = blur > 0 ? 'scale(1.06)' : '';
  }

  current?.apply?.(options);
  syncControls();
}

function syncControls() {
  const options = state.options;
  controls.opacity.value = String(Math.round(options.opacity * 100));
  controls.dim.value = String(Math.round(options.dim * 100));
  controls.blur.value = String(Math.round(options.blur));
  controls.speed.value = String(Math.round(options.speed * 100));
  controls.fps.value = String(options.fps);
  controls.volume.value = String(Math.round(options.volume * 100));
  controls.mute.checked = options.muted;
  controls.lowPower.checked = options.lowPower;
}

function toggleSheet(open) {
  sheet.hidden = !open;
  openButton.setAttribute('aria-expanded', String(open));

  if (open) {
    renderGrid();
    statusLine.textContent = 'Pick one, or add a file.';
  } else {
    releaseTileUrls();
  }
}

function bindControls() {
  const bind = (input, key, read) => {
    input.addEventListener('input', () => {
      state.options = normalizeState({ options: { ...state.options, [key]: read(input.value) } }).options;
      applyOptions();
      saveState();
    });
  };

  bind(controls.opacity, 'opacity', (value) => Number(value) / 100);
  bind(controls.dim, 'dim', (value) => Number(value) / 100);
  bind(controls.blur, 'blur', Number);
  bind(controls.speed, 'speed', (value) => Number(value) / 100);
  bind(controls.volume, 'volume', (value) => Number(value) / 100);

  // These two change how frames are produced, so the renderer restarts.
  controls.fps.addEventListener('change', () => {
    state.options = normalizeState({ options: { ...state.options, fps: Number(controls.fps.value) } }).options;
    saveState();
    show(state.activeId, { instant: true });
  });

  controls.lowPower.addEventListener('change', () => {
    state.options = normalizeState({ options: { ...state.options, lowPower: controls.lowPower.checked } }).options;
    saveState();
    show(state.activeId, { instant: true });
  });

  controls.mute.addEventListener('change', () => {
    state.options = normalizeState({ options: { ...state.options, muted: controls.mute.checked } }).options;
    applyOptions();
    saveState();
  });

  openButton.addEventListener('click', () => toggleSheet(sheet.hidden));
  closeButton.addEventListener('click', () => toggleSheet(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !sheet.hidden) toggleSheet(false);
  });

  fileInput.addEventListener('change', importFiles);

  // A hidden tab draws nothing: same page, same frame budget, zero cost.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) current?.pause?.();
    else current?.resume?.();
  });
}

export async function initWallpapers() {
  state = normalizeState(await readState());

  // The system asked for stillness: start on a static frame, and leave the
  // switch in the picker for anyone who wants motion back.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    state.options = normalizeState({ options: { ...state.options, lowPower: true } }).options;
  }

  bindControls();
  applyOptions();
  await show(state.activeId, { instant: true });
  renderGrid();

  // Switching mode restarts the renderer, which is how a live wallpaper becomes
  // a still frame and back again without a reload.
  document.addEventListener('atomperf', () => {
    applyOptions();
    show(state.activeId, { instant: true });
  });
}
