/**
 * The New Tab page is a doorway: type, hit Enter, and the sidebar opens with
 * the question already sent. Nothing is stored here beyond one pending prompt.
 */

const form = document.getElementById('ask');
const input = document.getElementById('q');
const foot = document.getElementById('foot');

document.getElementById('greet').textContent = greeting();
applyStoredTheme();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  if (typeof chrome === 'undefined' || !chrome.storage?.local || !chrome.sidePanel) {
    foot.textContent = 'This is a static preview — load the extension to use the sidebar.';
    return;
  }

  try {
    await chrome.storage.local.set({ 'atom.pending': { text, at: Date.now() } });
  } catch {
    foot.textContent = "Couldn't hand that to the sidebar.";
    return;
  }

  let opened = true;
  try {
    await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  } catch {
    opened = false;
  }

  input.value = '';
  if (!opened) foot.textContent = 'Open ATOM from the toolbar and it will pick that up.';
  input.focus();
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== input) {
    event.preventDefault();
    input.focus();
  }
});

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still awake?';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Keep the New Tab page on the same theme the sidebar uses. */
async function applyStoredTheme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;

  try {
    const stored = await chrome.storage.local.get('atom.settings');
    const preference = stored?.['atom.settings']?.theme || 'system';
    if (preference === 'system') return;
    document.documentElement.dataset.theme = preference;
  } catch {
    /* fall back to the system preference already applied */
  }
}
