/**
 * The graphics mode: Quality, Performance, or Auto (the system's reduced-motion
 * answer). Loaded in <head> and synchronous on purpose — localStorage is the one
 * store that can be read before the first paint, so nothing flashes and then
 * stops. The choice is mirrored into a data attribute the CSS keys off.
 */
(() => {
  const KEY = 'atom.perf';
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  const apply = () => {
    const saved = localStorage.getItem(KEY);
    const setting = saved === 'quality' || saved === 'performance' ? saved : 'auto';
    const mode = setting === 'auto' ? (reduced.matches ? 'performance' : 'quality') : setting;

    root.dataset.perfMode = setting;
    root.dataset.perf = mode;
    document.dispatchEvent(new CustomEvent('atomperf', { detail: { mode, setting } }));
  };

  window.atomPerf = {
    get mode() {
      return root.dataset.perf || 'quality';
    },
    get setting() {
      return root.dataset.perfMode || 'auto';
    },
    set(value) {
      localStorage.setItem(KEY, value === 'performance' || value === 'quality' ? value : 'auto');
      apply();
    },
    apply,
  };

  apply();

  // Another page changed it, or the system did.
  addEventListener('storage', (event) => {
    if (event.key === KEY) apply();
  });
  reduced.addEventListener('change', () => {
    if (root.dataset.perfMode === 'auto') apply();
  });
})();
