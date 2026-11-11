// Hosting shim only: wait for the asset service worker, then load the page once.
(() => {
  if (!('serviceWorker' in navigator) || navigator.serviceWorker.controller) return;
  let n = 0;
  try { n = +sessionStorage.getItem('ak-boot') || 0; sessionStorage.setItem('ak-boot', String(n + 1)); } catch { /* storage blocked */ }
  if (n > 2) return;
  const sw = new URL('sw.js', document.currentScript.src).href;
  try { window.stop(); } catch { /* ignore */ }
  navigator.serviceWorker.register(sw).then(() => navigator.serviceWorker.ready).then(() => setTimeout(() => location.reload(), 200)).catch(() => {});
})();
