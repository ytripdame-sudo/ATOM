/**
 * The start page's own script: apply the theme from Settings, draw the clock and
 * the pinned links, and follow changes live. The conversation is the panel in
 * the frame; nothing about it is handled here.
 */
import { normalizeSettings } from '../lib/settings.js';
import { initWallpapers } from './wallpaper.js';

const clock = document.getElementById('clock');
const greet = document.getElementById('greet');
const date = document.getElementById('date');
const links = document.getElementById('links');
const bg = document.getElementById('bg');

let current = normalizeSettings(null).startpage;

apply();
// Wallpapers are independent of the theme: they are their own layer, with their
// own storage, and they never block the page from being usable.
initWallpapers().catch(() => {});
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes['atom.settings']) apply();
});
setInterval(tick, 1000);

async function apply() {
  try {
    const stored = await chrome.storage.local.get('atom.settings');
    current = normalizeSettings(stored?.['atom.settings']).startpage;
  } catch {
    /* the defaults already applied */
  }
  render();
}

function render() {
  const theme = current;
  document.body.dataset.background = theme.background;
  document.body.dataset.font = theme.font;
  document.body.dataset.width = theme.width;
  document.documentElement.style.setProperty('--sp-accent', theme.accent);
  document.documentElement.style.setProperty('--sp-color', theme.color);

  // A picture is either a data URL the user uploaded or an https address; both
  // were validated when they were saved.
  bg.style.backgroundImage = theme.background === 'image' && theme.image ? `url("${theme.image}")` : '';

  clock.hidden = !theme.clock;
  greet.hidden = !theme.greeting;
  date.hidden = !theme.date;
  links.hidden = theme.links.length === 0;
  links.replaceChildren(
    ...theme.links.map((link) => {
      const anchor = document.createElement('a');
      anchor.href = link.url;
      anchor.textContent = link.title;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer noopener';
      return anchor;
    }),
  );

  tick();
}

function tick() {
  const now = new Date();
  clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  greet.textContent = greeting(now.getHours());
  date.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function greeting(hour) {
  if (hour < 5) return 'Still awake?';
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}
