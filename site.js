// Landing page logic. All text is inserted with textContent; no HTML from data.
const $ = s => document.querySelector(s);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
async function ready() {
  if (!('serviceWorker' in navigator)) return false;
  try { await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; return true; } catch { return false; }
}
(async () => {
  const [ok, data] = await Promise.all([ready(), fetch('data.json').then(r => r.json())]);
  const tabs = $('#tabs'), frame = $('#world'), status = $('#status');
  const show = id => {
    const run = data.runs.find(r => r.id === id) || data.runs[0];
    for (const b of tabs.children) { const on = b.dataset.id === run.id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
    frame.src = 'play/' + run.id + '/'; frame.title = run.label + ' game'; $('#open').href = frame.src;
    status.textContent = run.label + ': ' + (run.tools ? run.tools + ' asset tools available' : 'no asset tools') + ' · ' + run.slots + ' asset slots loaded from real files';
  };
  data.runs.forEach((run, i) => {
    const b = el('button', run.label); b.setAttribute('role', 'tab'); b.dataset.id = run.id; b.addEventListener('click', () => show(run.id));
    b.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + data.runs.length) % data.runs.length; show(data.runs[n].id); tabs.children[n].focus(); });
    tabs.append(b);
    const tr = el('tr'); tr.append(el('td', run.label), el('td', run.tools ? String(run.tools) : 'None'), el('td', run.slots), el('td', run.summary)); $('#rows').append(tr);
  });
  for (const c of data.credits) { const tr = el('tr'); tr.append(el('td', c.run), el('td', c.title), el('td', c.source), el('td', c.license)); $('#credits').append(tr); }
  $('#brief').textContent = data.briefSHA256;
  if (data.withheld.length) { const n = $('#withheldNote'); n.hidden = false; n.textContent = data.withheld.length + ' downloaded sound files are not published here because their licence does not allow redistribution. "Grab only" plays its built-in fallback tones instead.'; }
  if (data.video) { $('#video').hidden = false; $('#navVideo').hidden = false; const v = $('#demo'); v.src = data.video.src; if (data.video.poster) v.poster = data.video.poster; }
  if (ok) show(data.runs[0].id); else status.textContent = 'This browser blocks service workers, which the games need to load their files. Try a normal (non-private) window.';
})().catch(() => { $('#status').textContent = 'Could not load the run data.'; });
