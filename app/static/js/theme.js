(() => {
  const root = document.documentElement;
  const preference = window.matchMedia('(prefers-color-scheme: dark)');
  const key = 'smart-stock-theme';
  let saved;
  let toggle;
  try { saved = localStorage.getItem(key); } catch (_) {}
  if (saved !== 'light' && saved !== 'dark') saved = null;

  function syncTheme() {
    const dark = (saved || (preference.matches ? 'dark' : 'light')) === 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(dark));
      toggle.querySelector('.theme-icon').textContent = dark ? '☾' : '☀';
      toggle.querySelector('.theme-label').textContent = dark ? 'Dark' : 'Light';
    }
  }

  syncTheme();
  preference.addEventListener('change', syncTheme);
  document.addEventListener('DOMContentLoaded', () => {
    const container = document.querySelector('.topbar, .auth-brand');
    if (!container) return;
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'theme-toggle';
    toggle.setAttribute('aria-label', 'Dark mode');
    toggle.innerHTML = '<span class="theme-icon" aria-hidden="true"></span><span class="theme-label" aria-hidden="true"></span>';
    const logout = container.querySelector('[data-logout]');
    if (logout) {
      const actions = document.createElement('div');
      actions.className = 'topbar-actions';
      container.append(actions);
      actions.append(toggle, logout);
    } else {
      container.append(toggle);
    }
    toggle.addEventListener('click', () => {
      saved = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, saved); } catch (_) {}
      syncTheme();
    });
    syncTheme();
  });
})();
