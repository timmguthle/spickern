'use strict';

/* ============================================================
   Persistence
   ============================================================ */
const KEYS = { roster: 'darts.roster.v1', settings: 'darts.settings.v1', match: 'darts.match.v1' };

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
  mod: 1, // pending multiplier for the next dart: 1 single, 2 double, 3 triple
};
state.settings.players = state.settings.players.filter(n => state.roster.includes(n));

const persistSetup = () => { save(KEYS.settings, state.settings); save(KEYS.roster, state.roster); };
const persistMatch = () => save(KEYS.match, state.match);

/* ============================================================
   Helpers
   ============================================================ */
const $app = document.getElementById('app');
const $dialog = document.getElementById('dialog');
const $toast = document.getElementById('toast');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const buzz = pattern => { try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* ignore */ } };

// A dart is { n: number (0 = miss, 1–20, 25), x: multiplier (1–3) }
const dartValue = d => d.n * d.x;
function dartLabel(d) {
  if (d.n === 0) return 'Miss';
  if (d.n === 25) return d.x === 2 ? 'Bull' : '25';
  return (d.x === 3 ? 'T' : d.x === 2 ? 'D' : '') + d.n;
}

/* ============================================================
   Game engine — the whole leg is derived from the list of darts,
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
   Rendering — setup
   ============================================================ */
function render() {
  if (state.match) renderGame(); else renderSetup();
  keepAwake(!!state.match);
}

function renderSetup() {
  const s = state.settings;
  const bench = state.roster.filter(n => !s.players.includes(n));
  const full = s.players.length >= MAX_PLAYERS;

  $app.innerHTML = `
  <main class="setup">
    <header class="brand">
      <img src="icon.svg" alt="" width="44" height="44">
      <div><h1>Dart Scorer</h1><p>Pick a game, add players, throw.</p></div>
    </header>

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
          <span class="pos">${i + 1}</span><span class="pname">${esc(n)}</span>
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
            <button class="chip-x" data-act="forget" data-name="${esc(n)}" aria-label="Delete ${esc(n)}">✕</button>
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

/* ============================================================
   Rendering — game
   ============================================================ */
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
    <p>The current scores will be discarded.</p>
    <div class="dlg-actions"><div class="row">
      <button class="btn" data-act="close-dialog">Cancel</button>
      <button class="btn danger" data-act="new-game">End game</button>
    </div></div>`, 'confirm');
}

let toastTimer;
function toast(html, cls = '') {
  $toast.innerHTML = html;
  $toast.className = 'show ' + cls;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = cls; }, 1300);
}

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
  state.match = { start: s.start, doubleOut: s.doubleOut, players: [...s.players], legs: s.players.map(() => 0), leg: 1, starter: 0, throws: [] };
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
  state.mod = 1;
  persistMatch();
  closeDialog();
  render();
}

function endGame() {
  state.match = null;
  state.mod = 1;
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
    case 'miss': return addDart(0, 1);
    case 'bull': return addDart(25, 2);
    case 'undo': return undo();
    case 'menu': return showMenu();
    case 'close-dialog': closeDialog(); return;
    case 'confirm-end': return confirmEnd();
    case 'restart-leg': state.match.throws = []; persistMatch(); closeDialog(); break;
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

render();
