// Applied before the body renders so there's no flash of the wrong theme.
// Falls back to the OS-level preference the first time, then remembers
// whatever the person picks via the toggle button from then on.
(function(){
  var saved = null;
  try { saved = localStorage.getItem('vaultStudioTheme'); } catch(_) {}
  var theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
})();

