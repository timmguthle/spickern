'use strict';

/* ============================================================
   Persistence (browser)
   ============================================================ */
const KEYS = {
  roster: 'darts.roster.v1',
  settings: 'darts.settings.v1',
  match: 'darts.match.v1',
  stats: 'darts.stats.v1',
  meta: 'darts.statsmeta.v1',
};

function load(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* storage unavailable: app still works for this session */ }
}

const MAX_PLAYERS = 8;

const state = {
  roster: load(KEYS.roster, []),
  settings: { start: 501, doubleOut: true, players: [], ...load(KEYS.settings, {}) },
  match: load(KEYS.match, null),
  mod: 1,            // pending multiplier for the next dart: 1 single, 2 double, 3 triple
  view: 'setup',     // 'setup' | 'stats' (the game view shows whenever a match is running)
  statsFilter: 'all',
  showAllGames: false,
};
state.settings.players = state.settings.players.filter(n => state.roster.includes(n));

// Statistics: one record per finished leg. Everything else is computed from these.
let stats = load(KEYS.stats, { legs: [] });
if (!stats || !Array.isArray(stats.legs)) stats = { legs: [] };
// rev counts changes; exportedRev is the rev last written to a file by manual download.
const meta = { rev: 0, exportedRev: 0, ...load(KEYS.meta, {}) };

const persistSetup = () => { save(KEYS.settings, state.settings); save(KEYS.roster, state.roster); };
const persistMatch = () => save(KEYS.match, state.match);
function statsChanged() {
  meta.rev++;
  save(KEYS.stats, stats);
  save(KEYS.meta, meta);
  queueWrite();
}

/* ============================================================
   Helpers
   ============================================================ */
const $app = document.getElementById('app');
const $dialog = document.getElementById('dialog');
const $toast = document.getElementById('toast');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const buzz = pattern => { try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* ignore */ } };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const num = v => (Number.isFinite(+v) ? +v : 0);

// A dart is { n: number (0 = miss, 1–20, 25), x: multiplier (1–3) }
const dartValue = d => d.n * d.x;
function dartLabel(d) {
  if (d.n === 0) return 'Miss';
  if (d.n === 25) return d.x === 2 ? 'Bull' : '25';
  return (d.x === 3 ? 'T' : d.x === 2 ? 'D' : '') + d.n;
}

/* ============================================================
   Game engine: the whole leg is derived from the list of darts,
   so undo is just "remove the last dart".
   ============================================================ */
function replay(m) {
  const ps = m.players.map(name => ({ name, remaining: m.start, darts: 0, turns: [], high: 0 }));
  let cur = m.starter, turn = [], turnStart = m.start, winner = null, lastEvent = null;

  for (const d of m.throws) {
    const p = ps[cur];
    if (turn.length === 0) turnStart = p.remaining;
    turn.push(d);
    p.darts++;
    lastEvent = null;

    const after = p.remaining - dartValue(d);
    const bust = after < 0
      || (m.doubleOut && after === 1)
      || (m.doubleOut && after === 0 && d.x !== 2);

    if (bust) {
      p.remaining = turnStart;
      p.turns.push({ darts: turn, total: 0, bust: true });
      lastEvent = { type: 'bust', player: cur };
      turn = [];
      cur = (cur + 1) % ps.length;
      continue;
    }

    p.remaining = after;
    if (after === 0 || turn.length === 3) {
      const total = turnStart - after;
      p.turns.push({ darts: turn, total, bust: false });
      p.high = Math.max(p.high, total);
      if (after === 0) {
        winner = cur;
        lastEvent = { type: 'win', player: cur };
        turn = [];
        break;
      }
      lastEvent = { type: 'turn', player: cur, total };
      turn = [];
      cur = (cur + 1) % ps.length;
    }
  }
  return { ps, cur, turn, winner, lastEvent };
}

const average = (p, start) => p.darts ? ((start - p.remaining) / p.darts * 3).toFixed(1) : '–';

/* ============================================================
   Checkout suggestions
   ============================================================ */
const SEGMENTS = (() => {
  const s = [];
  for (let n = 1; n <= 20; n++) for (let x = 1; x <= 3; x++) s.push({ n, x, v: n * x });
  s.push({ n: 25, x: 1, v: 25 }, { n: 25, x: 2, v: 50 });
  return s;
})();
const DOUBLE_PREF = [20, 16, 18, 12, 10, 8, 14, 6, 4, 2, 19, 17, 15, 13, 11, 9, 7, 5, 3, 1, 25];

function setupCost(d) {
  if (d.x === 3) return d.n >= 15 ? 1 + (20 - d.n) * 0.12 : 2.2;
  if (d.x === 1) return d.n === 25 ? 3 : 1.05;
  return d.n === 25 ? 4 : 3.5; // doubles are poor setup shots
}
function finishCost(d, doubleOut) {
  if (doubleOut) return DOUBLE_PREF.indexOf(d.n) * 0.35;
  return d.x === 1 ? (d.n === 25 ? 2.5 : 0) : d.x === 3 ? 1 : 1.5;
}

const coCache = new Map();
function checkout(rem, darts, doubleOut) {
  if (rem <= 0 || darts <= 0 || rem > (doubleOut ? 170 : 180)) return null;
  const key = `${rem}|${darts}|${doubleOut}`;
  if (coCache.has(key)) return coCache.get(key);

  const finals = new Map();
  for (const f of SEGMENTS) {
    if (doubleOut && f.x !== 2) continue;
    if (!finals.has(f.v)) finals.set(f.v, []);
    finals.get(f.v).push(f);
  }
  let best = null, bestCost = Infinity;
  const consider = (setup, need) => {
    for (const f of finals.get(need) || []) {
      const c = setup.reduce((a, d) => a + setupCost(d), 0) + finishCost(f, doubleOut);
      if (c < bestCost) { bestCost = c; best = [...setup].sort((a, b) => b.v - a.v).concat(f); }
    }
  };
  for (let k = 1; k <= darts && !best; k++) {
    if (k === 1) consider([], rem);
    else if (k === 2) for (const a of SEGMENTS) consider([a], rem - a.v);
    else for (const a of SEGMENTS) for (const b of SEGMENTS) consider([a, b], rem - a.v - b.v);
  }
  coCache.set(key, best);
  return best;
}

/* ============================================================
   Statistics: recording and aggregation
   ============================================================ */
function buildLegRecord(m, g) {
  return {
    id: uid(),
    match: m.id,
    leg: m.leg,
    date: new Date().toISOString(),
    start: m.start,
    doubleOut: m.doubleOut,
    winner: g.ps[g.winner].name,
    players: g.ps.map((p, i) => {
      const scoring = p.turns.filter(t => !t.bust);
      const first3 = p.turns.slice(0, 3);
      const last = p.turns[p.turns.length - 1];
      return {
        name: p.name,
        darts: p.darts,
        points: m.start - p.remaining,
        left: p.remaining,
        high: p.high,
        busts: p.turns.length - scoring.length,
        t180: scoring.filter(t => t.total === 180).length,
        t140: scoring.filter(t => t.total >= 140 && t.total < 180).length,
        t100: scoring.filter(t => t.total >= 100 && t.total < 140).length,
        first9: first3.reduce((a, t) => a + t.total, 0),
        first9Darts: first3.reduce((a, t) => a + t.darts.length, 0),
        checkout: i === g.winner ? last.total : null,
        throws: p.turns.map(t => (t.bust ? '!' : '') + t.darts.map(dartLabel).join(' ')).join('|'),
      };
    }),
  };
}

// Keeps the stats in step with the leg: a won leg gets recorded once,
// and undoing the winning dart removes the record again.
function syncLegRecord() {
  const m = state.match;
  if (!m) return;
  if (!m.id) m.id = uid();
  const g = replay(m);
  if (g.winner != null && !m.legRecordId) {
    const rec = buildLegRecord(m, g);
    stats.legs.push(rec);
    m.legRecordId = rec.id;
    statsChanged();
  } else if (g.winner == null && m.legRecordId) {
    stats.legs = stats.legs.filter(l => l.id !== m.legRecordId);
    m.legRecordId = null;
    statsChanged();
  }
}

const legsFor = filter => stats.legs.filter(l => filter === 'all' || num(l.start) === +filter);

function aggregate(filter) {
  const map = new Map();
  for (const leg of legsFor(filter)) {
    for (const p of leg.players || []) {
      if (!p || typeof p.name !== 'string') continue;
      let a = map.get(p.name);
      if (!a) map.set(p.name, a = { name: p.name, legs: 0, won: 0, darts: 0, points: 0, f9: 0, f9d: 0, best: {}, hiCo: 0, high: 0, t180: 0, t140: 0, t100: 0, busts: 0 });
      const won = leg.winner === p.name;
      a.legs++;
      a.darts += num(p.darts);
      a.points += num(p.points);
      a.f9 += num(p.first9);
      a.f9d += num(p.first9Darts);
      a.high = Math.max(a.high, num(p.high));
      a.t180 += num(p.t180); a.t140 += num(p.t140); a.t100 += num(p.t100);
      a.busts += num(p.busts);
      if (won) {
        a.won++;
        a.hiCo = Math.max(a.hiCo, num(p.checkout));
        const s = num(leg.start);
        if (!a.best[s] || num(p.darts) < a.best[s]) a.best[s] = num(p.darts);
      }
    }
  }
  const list = [...map.values()].map(a => ({
    ...a,
    avg: a.darts ? a.points / a.darts * 3 : 0,
    f9avg: a.f9d ? a.f9 / a.f9d * 3 : 0,
    winPct: a.legs ? Math.round(a.won / a.legs * 100) : 0,
  }));
  return list.sort((x, y) => y.won - x.won || y.avg - x.avg);
}

function gameList(filter) {
  const by = new Map();
  for (const l of legsFor(filter)) {
    const key = l.match || l.id;
    let g = by.get(key);
    if (!g) by.set(key, g = { date: String(l.date || ''), start: num(l.start), doubleOut: !!l.doubleOut, players: (l.players || []).map(p => p.name), wins: {}, legs: 0, darts: {} });
    g.legs++;
    g.wins[l.winner] = (g.wins[l.winner] || 0) + 1;
    if (String(l.date) > g.date) g.date = String(l.date);
    const w = (l.players || []).find(p => p.name === l.winner);
    if (w) g.darts[l.winner] = Math.min(g.darts[l.winner] || Infinity, num(w.darts));
  }
  return [...by.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleString(undefined, opts);
}

/* ============================================================
   Stats file on the user's computer
   - Chrome/Edge: the File System Access API keeps a file connected,
     so every finished leg is written to it automatically.
   - Other browsers: save (download) and load (upload) manually.
   ============================================================ */
const FS = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
const FILE_TYPES = [{ description: 'Spickern stats', accept: { 'application/json': ['.json'] } }];
const FILE_NAME = 'spickern-stats.json';
const file = { handle: null, status: 'none', saving: false, savedAt: null, error: '' }; // status: none | prompt | connected | error

function serialize() {
  return JSON.stringify({ app: 'spickern', version: 1, savedAt: new Date().toISOString(), roster: state.roster, legs: stats.legs }, null, 2);
}

function parseStatsFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not a Spickern stats file.'); }
  if (!data || data.app !== 'spickern' || !Array.isArray(data.legs)) throw new Error('That file is not a Spickern stats file.');
  return data;
}

// Combines the file's legs with the ones in this browser (nothing is lost on either side).
function mergeData(data) {
  const known = new Set(stats.legs.map(l => l.id));
  let added = 0;
  for (const l of data.legs) {
    if (!l || typeof l.id !== 'string' || !Array.isArray(l.players) || known.has(l.id)) continue;
    stats.legs.push(l);
    known.add(l.id);
    added++;
  }
  stats.legs.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const names = new Set(state.roster.map(n => n.toLowerCase()));
  for (const n of Array.isArray(data.roster) ? data.roster : []) {
    if (typeof n !== 'string' || !n.trim() || names.has(n.toLowerCase())) continue;
    state.roster.push(n.trim().slice(0, 20));
    names.add(n.toLowerCase());
  }
  persistSetup();

  const fileIds = new Set(data.legs.map(l => l && l.id));
  const fileIsMissing = stats.legs.some(l => !fileIds.has(l.id));
  if (added) { meta.rev++; save(KEYS.stats, stats); save(KEYS.meta, meta); }
  return { added, fileIsMissing };
}

// --- IndexedDB, only used to remember which file is connected ---
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('spickern', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      } catch (e) {
        reject(e);
      }
    };
  });
}
const idbGet = k => idb('readonly', s => s.get(k));
const idbSet = (k, v) => idb('readwrite', s => s.put(v, k));
const idbDel = k => idb('readwrite', s => s.delete(k));

let writeChain = Promise.resolve();
function queueWrite() {
  if (!file.handle || file.status !== 'connected') return writeChain;
  file.saving = true;
  writeChain = writeChain.then(async () => {
    try {
      const w = await file.handle.createWritable();
      await w.write(serialize());
      await w.close();
      file.savedAt = new Date();
      file.error = '';
    } catch (e) {
      file.status = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'prompt' : 'error';
      file.error = (e && e.message) || 'Unknown error';
    }
    file.saving = false;
    refreshFileUi();
  });
  return writeChain;
}

// Reads the file (if it has data), merges it in, and connects it for auto-saving.
async function connectHandle(handle, mode) {
  const text = (await (await handle.getFile()).text()).trim();
  let result = { added: 0, fileIsMissing: true };
  if (text) {
    try { result = mergeData(parseStatsFile(text)); }
    catch (e) { if (mode === 'open') throw e; /* 'create': user chose to replace it */ }
  }
  file.handle = handle;
  file.status = 'connected';
  file.error = '';
  try { await idbSet('statsFile', handle); } catch { /* remembered for this session only */ }
  if (result.fileIsMissing) await queueWrite();
  else file.savedAt = new Date();
  return result.added;
}

function legsMsg(added) {
  return added ? ` · ${added} leg${added === 1 ? '' : 's'} loaded` : '';
}

async function openStatsFile() {
  if (!FS) return pickFileFallback();
  try {
    const [h] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
    const added = await connectHandle(h, 'open');
    toastMsg(`Connected to ${esc(h.name)}${legsMsg(added)}`);
  } catch (e) {
    if (e.name !== 'AbortError') toastMsg(esc(e.message), true);
  }
  render();
}

async function createStatsFile() {
  try {
    const h = await window.showSaveFilePicker({ suggestedName: FILE_NAME, types: FILE_TYPES });
    const added = await connectHandle(h, 'create');
    toastMsg(`Saving stats to ${esc(h.name)}${legsMsg(added)}`);
  } catch (e) {
    if (e.name !== 'AbortError') toastMsg(esc(e.message), true);
  }
  render();
}

async function reconnectFile() {
  const h = file.handle;
  if (!h) return openStatsFile();
  try {
    const perm = await h.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('Spickern needs permission to use the file.');
    const added = await connectHandle(h, 'open');
    toastMsg(`Connected to ${esc(h.name)}${legsMsg(added)}`);
  } catch (e) {
    if (e.name === 'NotFoundError') {
      await disconnectFile();
      toastMsg('The stats file was moved or deleted. Open it again.', true);
    } else if (e.name !== 'AbortError') {
      file.status = 'error';
      file.error = e.message;
      toastMsg(esc(e.message), true);
    }
  }
  render();
}

async function disconnectFile() {
  file.handle = null;
  file.status = 'none';
  file.savedAt = null;
  try { await idbDel('statsFile'); } catch { /* ignore */ }
  render();
}

function downloadStats() {
  const blob = new Blob([serialize()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = FILE_NAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  meta.exportedRev = meta.rev;
  save(KEYS.meta, meta);
  render();
}

function pickFileFallback() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      const r = mergeData(parseStatsFile(await f.text()));
      if (!r.fileIsMissing) { meta.exportedRev = meta.rev; save(KEYS.meta, meta); }
      toastMsg(`Loaded ${esc(f.name)}${legsMsg(r.added)}`);
    } catch (e) {
      toastMsg(esc(e.message), true);
    }
    render();
  };
  input.click();
}

async function initFile() {
  if (!FS || !window.indexedDB) return;
  try {
    const h = await idbGet('statsFile');
    if (!h) return;
    file.handle = h;
    file.status = 'prompt';
    if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') await connectHandle(h, 'open');
  } catch {
    if (file.handle && file.status !== 'connected') file.status = 'prompt';
  }
  render();
}

function refreshFileUi() {
  if (state.match) {
    const note = document.getElementById('save-note');
    if (note) note.innerHTML = saveNote();
  } else if (!document.activeElement || document.activeElement.tagName !== 'INPUT') {
    render();
  }
}

function saveNote() {
  if (file.status === 'connected') {
    return file.saving ? `Saving to ${esc(file.handle.name)}…` : `✓ Stats saved to ${esc(file.handle.name)}`;
  }
  if (file.status === 'prompt' || file.status === 'error') return 'Stats saved in this browser. Reconnect your stats file on the start screen.';
  return FS
    ? 'Stats saved in this browser. Connect a stats file on the start screen to keep them on your computer.'
    : 'Stats saved in this browser. Use “Save file” on the start screen to keep them on your computer.';
}

/* ============================================================
   Rendering
   ============================================================ */
function render() {
  if (state.match) renderGame();
  else if (state.view === 'stats') renderStats();
  else renderSetup();
  keepAwake(!!state.match);
}

const ICON_FILE = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 2.5h6.5L15.5 6.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z"/><path d="M11.5 2.5v4h4"/></svg>';
const ICON_CHART = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 15V9M9 15V3M15 15v-4"/></svg>';
const ICON_BACK = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3 5 9l6 6"/></svg>';

// Compact one-line status on the start screen.
function fileBanner() {
  let icon = 'idle', text, actions;
  if (FS) {
    if (file.status === 'connected') {
      icon = 'ok';
      text = `<b>${esc(file.handle.name)}</b><small>Stats are saved here automatically</small>`;
      actions = '<button class="btn sm" data-act="go-stats">View stats</button>';
    } else if (file.status === 'prompt' || file.status === 'error') {
      icon = 'warn';
      text = `<b>${esc(file.handle.name)}</b><small>${file.status === 'error' ? 'Could not save. Reconnect the file.' : 'Reconnect to load your stats and keep saving'}</small>`;
      actions = '<button class="btn sm primary" data-act="reconnect-file">Reconnect</button>';
    } else {
      text = '<b>Stats file</b><small>Keep your stats in a file on this computer</small>';
      actions = '<button class="btn sm primary" data-act="open-file">Open</button><button class="btn sm" data-act="create-file">New</button>';
    }
  } else {
    const unsaved = meta.rev > meta.exportedRev && stats.legs.length > 0;
    icon = unsaved ? 'warn' : 'idle';
    text = unsaved
      ? '<b>Unsaved stats</b><small>Save them to a file on your device</small>'
      : '<b>Stats file</b><small>Load your saved stats file</small>';
    actions = `<button class="btn sm ${unsaved ? '' : 'primary'}" data-act="open-file">Load</button><button class="btn sm ${unsaved ? 'primary' : ''}" data-act="download-file">Save file</button>`;
  }
  return `<section class="file-banner ${icon}"><span class="fb-icon">${ICON_FILE}</span><span class="fb-text">${text}</span><span class="fb-actions">${actions}</span></section>`;
}

function renderSetup() {
  const s = state.settings;
  const bench = state.roster.filter(n => !s.players.includes(n));
  const full = s.players.length >= MAX_PLAYERS;
  const career = new Map(aggregate('all').map(a => [a.name, a]));
  const sub = n => {
    const a = career.get(n);
    return a ? `<small>Avg ${a.avg.toFixed(1)} · ${a.won}/${a.legs} legs won</small>` : '';
  };

  $app.innerHTML = `
  <main class="setup">
    <header class="brand">
      <img src="icon.svg" alt="" width="44" height="44">
      <div><h1>Spickern</h1><p>Dart scoring, 301 &amp; 501</p></div>
      <button class="icon-btn labeled" data-act="go-stats">${ICON_CHART}<span>Stats</span></button>
    </header>

    ${fileBanner()}

    <section class="panel">
      <h2>Starting score</h2>
      <div class="seg" role="radiogroup" aria-label="Starting score">
        ${[301, 501].map(v => `<button role="radio" aria-checked="${s.start === v}" class="${s.start === v ? 'on' : ''}" data-act="start-score" data-value="${v}">${v}</button>`).join('')}
      </div>
      <label class="toggle-row">
        <span><strong>Double out</strong><small>The last dart must hit a double or the bull</small></span>
        <input type="checkbox" class="switch" id="double-out" ${s.doubleOut ? 'checked' : ''}>
      </label>
    </section>

    <section class="panel">
      <h2>Players <span class="badge">${s.players.length}</span>
        ${s.players.length > 1 ? '<button class="link" data-act="shuffle">Shuffle order</button>' : ''}</h2>
      ${s.players.length ? `<ol class="lineup">${s.players.map((n, i) => `
        <li>
          <span class="pos">${i + 1}</span><span class="pname">${esc(n)}${sub(n)}</span>
          <button class="mini" data-act="move-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(n)} up">↑</button>
          <button class="mini" data-act="unpick" data-i="${i}" aria-label="Remove ${esc(n)} from game">✕</button>
        </li>`).join('')}</ol>`
      : '<p class="empty">No players yet. Add someone below.</p>'}
      <form class="add-player" id="add-form" autocomplete="off">
        <input name="name" maxlength="20" placeholder="${full ? 'Max 8 players' : 'Player name'}" enterkeyhint="done" ${full ? 'disabled' : ''} aria-label="New player name">
        <button class="btn" type="submit" ${full ? 'disabled' : ''}>Add</button>
      </form>
      ${bench.length ? `
      <div class="bench">
        <span class="bench-label">Saved players: tap to add</span>
        <div class="chips">${bench.map(n => `
          <span class="chip">
            <button data-act="pick" data-name="${esc(n)}" ${full ? 'disabled' : ''}>+ ${esc(n)}</button>
            <button class="chip-x" data-act="forget" data-name="${esc(n)}" aria-label="Remove ${esc(n)} from saved players">✕</button>
          </span>`).join('')}
        </div>
      </div>` : ''}
    </section>

    <div class="start-bar">
      <button class="btn primary big" data-act="start-game" ${s.players.length ? '' : 'disabled'}>
        ${s.players.length ? `Start ${s.start}${s.doubleOut ? ' · Double out' : ''}` : 'Add a player to start'}
      </button>
    </div>
  </main>`;
}

/* ---------- statistics page ---------- */
function filePanel() {
  let body, actions;
  if (FS) {
    if (file.status === 'connected') {
      const when = file.savedAt ? ` Last saved ${file.savedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.` : '';
      body = `<b>${esc(file.handle.name)}</b><small>Connected. Every finished leg is saved to this file automatically.${when}</small>`;
      actions = '<button class="btn" data-act="open-file">Open other file</button><button class="btn" data-act="disconnect-file">Disconnect</button>';
    } else if (file.status === 'prompt' || file.status === 'error') {
      body = `<b>${esc(file.handle.name)}</b><small>${file.status === 'error' ? `Could not save (${esc(file.error)}).` : 'Your browser needs your OK to use this file again.'}</small>`;
      actions = '<button class="btn primary" data-act="reconnect-file">Reconnect</button><button class="btn" data-act="open-file">Open other file</button>';
    } else {
      body = '<b>Not connected</b><small>Stats are only kept in this browser. Open your stats file to load it, or create a new one. After that, every finished leg is saved to it automatically.</small>';
      actions = '<button class="btn primary" data-act="open-file">Open stats file</button><button class="btn" data-act="create-file">Create new file</button>';
    }
  } else {
    const unsaved = meta.rev > meta.exportedRev && stats.legs.length > 0;
    body = `<b>${unsaved ? 'Unsaved changes' : 'Saved in this browser'}</b><small>This browser can't keep a file connected. Save the file after playing and load it next time. Chrome or Edge on a computer can save automatically.</small>`;
    actions = `<button class="btn ${unsaved ? 'primary' : ''}" data-act="download-file">Save file</button><button class="btn ${unsaved ? '' : 'primary'}" data-act="open-file">Load file</button>`;
  }
  const backup = FS && stats.legs.length ? '<button class="link" data-act="download-file">Download a copy</button>' : '';
  return `
    <section class="panel">
      <h2>Stats file ${backup}</h2>
      <div class="file-row"><span class="fb-icon">${ICON_FILE}</span><span class="fb-text">${body}</span></div>
      <div class="file-actions">${actions}</div>
    </section>`;
}

const cell = (label, value) => `<div class="cell"><span>${label}</span><b>${value}</b></div>`;

function playerStatCard(a, filter) {
  const bestCells = filter === 'all'
    ? cell('Best 501', a.best[501] ? `${a.best[501]} <small>darts</small>` : '–') + cell('Best 301', a.best[301] ? `${a.best[301]} <small>darts</small>` : '–')
    : cell('Best leg', a.best[+filter] ? `${a.best[+filter]} <small>darts</small>` : '–');
  return `
    <article class="pstat">
      <div class="pstat-head">
        <span class="pstat-name">${esc(a.name)}</span>
        <span class="pstat-avg"><b>${a.avg.toFixed(1)}</b><small>3-dart avg</small></span>
      </div>
      <div class="pstat-grid">
        ${cell('Legs', a.legs)}${cell('Won', a.won)}${cell('Win rate', a.winPct + '%')}${cell('First 9', a.f9d ? a.f9avg.toFixed(1) : '–')}
        ${bestCells}${cell('Top finish', a.hiCo || '–')}${cell('Top score', a.high || '–')}
        ${cell('180s', a.t180)}${cell('140+', a.t140)}${cell('100+', a.t100)}${cell('Busts', a.busts)}${filter === 'all' ? '' : cell('Darts', a.darts)}
      </div>
    </article>`;
}

function gameRow(g) {
  const ranked = [...g.players].sort((a, b) => (g.wins[b] || 0) - (g.wins[a] || 0));
  const top = g.wins[ranked[0]] || 0;
  const solo = g.players.length === 1;
  return `
    <li class="game-row">
      <div class="gr-top"><span>${esc(fmtDate(g.date))}</span><span>${g.start} · ${g.doubleOut ? 'Double out' : 'Single out'} · ${g.legs} leg${g.legs === 1 ? '' : 's'}</span></div>
      <div class="gr-players">${ranked.map(n => `
        <span class="${(g.wins[n] || 0) === top && top > 0 ? 'w' : ''}">${esc(n)} <b>${solo ? `${g.darts[n]} darts` : g.wins[n] || 0}</b></span>`).join('')}
      </div>
    </li>`;
}

function renderStats() {
  const f = state.statsFilter;
  const players = aggregate(f);
  const games = gameList(f);
  const shown = state.showAllGames ? games : games.slice(0, 20);
  $app.innerHTML = `
  <main class="setup stats-page">
    <header class="page-head">
      <button class="icon-btn" data-act="go-setup" aria-label="Back">${ICON_BACK}</button>
      <h1>Statistics</h1>
    </header>

    ${filePanel()}

    <div class="seg filter" role="radiogroup" aria-label="Filter by game">
      ${['all', '301', '501'].map(v => `<button role="radio" aria-checked="${f === v}" class="${f === v ? 'on' : ''}" data-act="stats-filter" data-value="${v}">${v === 'all' ? 'All games' : v}</button>`).join('')}
    </div>

    <section class="panel">
      <h2>Players <span class="badge">${players.length}</span></h2>
      ${players.length ? players.map(a => playerStatCard(a, f)).join('') : '<p class="empty">No finished legs yet. Play a game and the stats show up here.</p>'}
    </section>

    <section class="panel">
      <h2>Recent games <span class="badge">${games.length}</span></h2>
      ${games.length ? `<ul class="games">${shown.map(gameRow).join('')}</ul>` : '<p class="empty">No games yet.</p>'}
      ${games.length > shown.length ? `<button class="btn" data-act="show-all-games">Show all ${games.length} games</button>` : ''}
    </section>
  </main>`;
}

/* ---------- game ---------- */
function renderGame() {
  const m = state.match;
  const g = replay(m);
  const p = g.ps[g.cur];
  const dartsLeft = 3 - g.turn.length;
  const turnTotal = g.turn.reduce((a, d) => a + dartValue(d), 0);
  const co = g.winner == null ? checkout(p.remaining, dartsLeft, m.doubleOut) : null;
  const mod = state.mod;
  const prefix = mod === 3 ? 'T' : mod === 2 ? 'D' : '';
  const last = p.turns[p.turns.length - 1];

  let coHtml = '<span class="lbl">&nbsp;</span>';
  if (co) coHtml = `<span class="lbl">Checkout</span>${co.map(d => `<b>${dartLabel(d)}</b>`).join('<i>›</i>')}`;
  else if (g.winner == null && p.remaining <= 170 && m.doubleOut && checkout(p.remaining, 3, true) === null)
    coHtml = '<span class="lbl">No checkout yet</span>';

  $app.innerHTML = `
  <main class="game">
    <header class="topbar">
      <button class="icon-btn" data-act="menu" aria-label="Game menu">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 4h14M2 9h14M2 14h14"/></svg>
      </button>
      <div class="meta"><strong>${m.start}</strong> · ${m.doubleOut ? 'Double out' : 'Single out'}${m.players.length > 1 ? ` · Leg ${m.leg}` : ''}</div>
    </header>

    <section class="board" aria-label="Scoreboard">
      ${g.ps.map((pl, i) => {
        const lt = pl.turns[pl.turns.length - 1];
        return `
        <div class="pcard ${i === g.cur && g.winner == null ? 'on' : ''}">
          <div class="pc-name"><span>${esc(pl.name)}</span>${m.legs[i] ? `<span class="legs">${m.legs[i]}</span>` : ''}</div>
          <div class="pc-score">${pl.remaining}</div>
          <div class="pc-stats"><span>Avg ${average(pl, m.start)}</span><span>${lt ? (lt.bust ? 'Bust' : 'Last ' + lt.total) : ''}</span></div>
        </div>`;
      }).join('')}
    </section>

    <section class="active" aria-live="polite">
      <div class="a-top">
        <span class="a-name">${esc(p.name)}</span>
        <span class="a-hint">${dartsLeft} dart${dartsLeft === 1 ? '' : 's'} left</span>
      </div>
      <div class="a-main">
        <div class="a-score">${p.remaining}</div>
        <div class="a-turn">
          <div class="slots">${[0, 1, 2].map(i => {
            const d = g.turn[i];
            const cls = d ? (i === g.turn.length - 1 && state.justThrew ? 'filled new' : 'filled') : i === g.turn.length ? 'next' : '';
            return `<div class="slot ${cls}">${d ? dartLabel(d) : ''}</div>`;
          }).join('')}</div>
          <div class="a-total">${g.turn.length ? `This turn <b>${turnTotal}</b>` : last ? `Last turn ${last.bust ? '<b>Bust</b>' : `<b>${last.total}</b>`}` : ''}</div>
        </div>
      </div>
      <div class="checkout ${co ? '' : 'none'}">${coHtml}</div>
    </section>

    <section class="pad mod-${mod}" aria-label="Score input">
      <div class="mods">
        <button class="mod dbl ${mod === 2 ? 'on' : ''}" data-mod="2" aria-pressed="${mod === 2}">Double</button>
        <button class="mod trp ${mod === 3 ? 'on' : ''}" data-mod="3" aria-pressed="${mod === 3}">Triple</button>
      </div>
      <div class="nums">
        ${Array.from({ length: 20 }, (_, i) => i + 1).map(v => `
          <button class="key" data-num="${v}" aria-label="${prefix}${v}">
            <span class="k-main">${prefix}${v}</span>${mod > 1 ? `<span class="k-sub">${v * mod}</span>` : ''}
          </button>`).join('')}
      </div>
      <div class="specials">
        <button class="key txt" data-act="miss"><span class="k-main">Miss</span></button>
        <button class="key" data-num="25" ${mod === 3 ? 'disabled' : ''}>
          <span class="k-main">${mod === 2 ? 'Bull' : '25'}</span><span class="k-sub">${mod === 2 ? '50' : 'Outer bull'}</span>
        </button>
        <button class="key bull" data-act="bull"><span class="k-main">Bull</span><span class="k-sub">50</span></button>
        <button class="key txt undo" data-act="undo" ${m.throws.length ? '' : 'disabled'} aria-label="Undo last dart">
          <span class="k-main">↶ Undo</span>
        </button>
      </div>
      <div class="shortcuts">Keyboard: type a number · <kbd>D</kbd> double · <kbd>T</kbd> triple · <kbd>B</kbd> bull · <kbd>0</kbd> miss · <kbd>⌫</kbd> undo</div>
    </section>
  </main>`;

  $app.querySelector('.pcard.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });

  if (g.winner != null) showWin(g);
  else if ($dialog.open && $dialog.dataset.kind === 'win') closeDialog();
}

/* ============================================================
   Dialogs & toast
   ============================================================ */
function openDialog(html, kind) {
  $dialog.innerHTML = html;
  $dialog.dataset.kind = kind;
  if (!$dialog.open) $dialog.showModal();
}
function closeDialog() {
  if ($dialog.open) $dialog.close();
  $dialog.dataset.kind = '';
}
$dialog.addEventListener('cancel', e => { if ($dialog.dataset.kind === 'win') e.preventDefault(); else $dialog.dataset.kind = ''; });
$dialog.addEventListener('click', e => { if (e.target === $dialog && $dialog.dataset.kind !== 'win') closeDialog(); });

function showWin(g) {
  const m = state.match;
  const w = g.ps[g.winner];
  const lastTurn = w.turns[w.turns.length - 1];
  const finalDart = lastTurn.darts[lastTurn.darts.length - 1];
  const multi = m.players.length > 1;
  openDialog(`
    <div class="win">
      <div class="win-icon">🎯</div>
      <h2>${esc(w.name)} wins${multi ? ` leg ${m.leg}` : ''}!</h2>
      <p class="win-sub">Checked out <b>${lastTurn.total}</b> on <b>${dartLabel(finalDart)}</b> · ${w.darts} darts</p>
      <table class="stats">
        <thead><tr><th>Player</th>${multi ? '<th>Legs</th>' : ''}<th>Avg</th><th>Best</th><th>Left</th></tr></thead>
        <tbody>${g.ps.map((pl, i) => `
          <tr class="${i === g.winner ? 'w' : ''}">
            <td>${esc(pl.name)}</td>${multi ? `<td>${m.legs[i] + (i === g.winner ? 1 : 0)}</td>` : ''}
            <td>${average(pl, m.start)}</td><td>${pl.high || '–'}</td><td>${pl.remaining}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p class="save-note" id="save-note">${saveNote()}</p>
      <div class="dlg-actions">
        <button class="btn primary big" data-act="next-leg">${multi ? 'Next leg' : 'Play again'}</button>
        <div class="row">
          <button class="btn" data-act="undo">↶ Undo dart</button>
          <button class="btn" data-act="new-game">New game</button>
        </div>
      </div>
    </div>`, 'win');
}

function showMenu() {
  openDialog(`
    <h2>Game menu</h2>
    <p>${state.match.players.map(esc).join(', ')}</p>
    <div class="dlg-actions">
      <button class="btn primary" data-act="close-dialog">Resume game</button>
      <button class="btn" data-act="restart-leg">Restart this leg</button>
      <button class="btn danger" data-act="confirm-end">End game</button>
    </div>`, 'menu');
}

function confirmEnd() {
  openDialog(`
    <h2>End this game?</h2>
    <p>The leg in progress is not counted. Finished legs stay in the stats.</p>
    <div class="dlg-actions"><div class="row">
      <button class="btn" data-act="close-dialog">Cancel</button>
      <button class="btn danger" data-act="new-game">End game</button>
    </div></div>`, 'confirm');
}

let toastTimer;
function toast(html, cls = '', ms = 1300) {
  $toast.innerHTML = html;
  $toast.className = 'show ' + cls;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = cls; }, ms);
}
const toastMsg = (text, isError = false) => toast(`<span>${text}</span>`, isError ? 'msg err' : 'msg', 3200);

/* ============================================================
   Actions
   ============================================================ */
function addName(raw) {
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, 20);
  if (!name) return;
  const s = state.settings;
  const existing = state.roster.find(n => n.toLowerCase() === name.toLowerCase());
  const finalName = existing || name;
  if (!existing) state.roster.push(finalName);
  if (!s.players.includes(finalName) && s.players.length < MAX_PLAYERS) s.players.push(finalName);
  persistSetup();
}

function startGame() {
  const s = state.settings;
  if (!s.players.length) return;
  state.match = { id: uid(), start: s.start, doubleOut: s.doubleOut, players: [...s.players], legs: s.players.map(() => 0), leg: 1, starter: 0, throws: [], legRecordId: null };
  state.mod = 1;
  persistMatch();
}

function addDart(n, x) {
  const m = state.match;
  if (!m || replay(m).winner != null) return;
  if (n === 25 && x === 3) return;
  if (n === 0) x = 1;
  m.throws.push({ n, x });
  state.mod = 1;
  syncLegRecord();
  persistMatch();
  buzz(8);

  const g = replay(m);
  state.justThrew = true;
  render();
  state.justThrew = false;
  const ev = g.lastEvent;
  if (!ev) return;
  const who = esc(g.ps[ev.player].name);
  if (ev.type === 'bust') {
    buzz([40, 60, 40]);
    toast(`<b>BUST</b><span>${who} stays on ${g.ps[ev.player].remaining}</span>`, 'bust');
  } else if (ev.type === 'turn') {
    toast(`<b>${ev.total}</b><span>${ev.total === 180 ? 'ONE HUNDRED AND EIGHTY!' : who}</span>`, ev.total >= 100 ? 'big' : '');
  } else if (ev.type === 'win') {
    buzz([60, 40, 120]);
  }
}

function undo() {
  const m = state.match;
  if (!m || !m.throws.length) return;
  m.throws.pop();
  state.mod = 1;
  syncLegRecord();
  persistMatch();
  buzz(15);
  render();
}

function nextLeg() {
  const m = state.match;
  const g = replay(m);
  if (g.winner == null) return;
  m.legs[g.winner]++;
  m.leg++;
  m.starter = (m.starter + 1) % m.players.length; // starting player rotates each leg
  m.throws = [];
  m.legRecordId = null; // the finished leg stays in the stats
  state.mod = 1;
  persistMatch();
  closeDialog();
  render();
}

function endGame() {
  state.match = null;
  state.mod = 1;
  state.view = 'setup';
  persistMatch();
  closeDialog();
  render();
  window.scrollTo(0, 0);
}

/* ============================================================
   Events
   ============================================================ */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act],[data-num],[data-mod]');
  if (!el || el.disabled) return;
  const s = state.settings;

  if (el.dataset.num) return addDart(+el.dataset.num, state.mod);
  if (el.dataset.mod) {
    const v = +el.dataset.mod;
    state.mod = state.mod === v ? 1 : v;
    buzz(5);
    return render();
  }

  switch (el.dataset.act) {
    case 'start-score': s.start = +el.dataset.value; persistSetup(); break;
    case 'shuffle':
      for (let i = s.players.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [s.players[i], s.players[j]] = [s.players[j], s.players[i]];
      }
      persistSetup(); break;
    case 'move-up': {
      const i = +el.dataset.i;
      if (i > 0) [s.players[i - 1], s.players[i]] = [s.players[i], s.players[i - 1]];
      persistSetup(); break;
    }
    case 'unpick': s.players.splice(+el.dataset.i, 1); persistSetup(); break;
    case 'pick': if (s.players.length < MAX_PLAYERS) s.players.push(el.dataset.name); persistSetup(); break;
    case 'forget':
      state.roster = state.roster.filter(n => n !== el.dataset.name);
      persistSetup(); break;
    case 'start-game': startGame(); break;
    case 'go-stats': state.view = 'stats'; state.showAllGames = false; render(); window.scrollTo(0, 0); return;
    case 'go-setup': state.view = 'setup'; render(); window.scrollTo(0, 0); return;
    case 'stats-filter': state.statsFilter = el.dataset.value; break;
    case 'show-all-games': state.showAllGames = true; break;
    case 'open-file': return openStatsFile();
    case 'create-file': return createStatsFile();
    case 'reconnect-file': return reconnectFile();
    case 'disconnect-file': return disconnectFile();
    case 'download-file': return downloadStats();
    case 'miss': return addDart(0, 1);
    case 'bull': return addDart(25, 2);
    case 'undo': return undo();
    case 'menu': return showMenu();
    case 'close-dialog': closeDialog(); return;
    case 'confirm-end': return confirmEnd();
    case 'restart-leg': state.match.throws = []; syncLegRecord(); persistMatch(); closeDialog(); break;
    case 'next-leg': return nextLeg();
    case 'new-game': return endGame();
    default: return;
  }
  render();
});

document.addEventListener('change', e => {
  if (e.target.id === 'double-out') {
    state.settings.doubleOut = e.target.checked;
    persistSetup();
    render();
  }
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'add-form') return;
  e.preventDefault();
  addName(new FormData(e.target).get('name') || '');
  render();
  document.querySelector('#add-form input')?.focus();
});

// Keyboard input for desktop: type "20", "d" + "16", "t" + "19", "b", "0", Backspace.
let keyBuf = '', keyTimer = null;
function flushKeys() {
  clearTimeout(keyTimer);
  if (!keyBuf) return;
  const v = +keyBuf;
  keyBuf = '';
  if (v === 0) addDart(0, 1);
  else if (v <= 20 || v === 25) addDart(v, state.mod);
}
function pushDigit(dg) {
  const next = keyBuf + dg;
  if (keyBuf && !(+next <= 20 || +next === 25)) { flushKeys(); return pushDigit(dg); }
  keyBuf = next;
  clearTimeout(keyTimer);
  if (keyBuf === '1' || keyBuf === '2') keyTimer = setTimeout(flushKeys, 650);
  else flushKeys();
}
document.addEventListener('keydown', e => {
  if (!state.match || $dialog.open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (/^[0-9]$/.test(k)) { e.preventDefault(); return pushDigit(k); }
  if (k === 'enter') { e.preventDefault(); return flushKeys(); }
  if (k === 'backspace') {
    e.preventDefault();
    if (keyBuf) { keyBuf = ''; clearTimeout(keyTimer); } else undo();
    return;
  }
  if (k === 'd' || k === 't' || k === 's') {
    const v = k === 'd' ? 2 : k === 't' ? 3 : 1;
    state.mod = state.mod === v ? 1 : v;
    return render();
  }
  if (k === 'b') return addDart(25, 2);
  if (k === 'm' || k === 'x') return addDart(0, 1);
});

/* Keep the screen on while a game is running (supported browsers only). */
let wakeLock = null, wakeBusy = false;
async function keepAwake(on) {
  if (!('wakeLock' in navigator) || wakeBusy) return;
  wakeBusy = true;
  try {
    if (on && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed right now */ }
  wakeBusy = false;
}
document.addEventListener('visibilitychange', () => keepAwake(!!state.match));

if (state.match && !state.match.id) state.match.id = uid();
render();
initFile();
