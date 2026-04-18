// Gomoku — built-in MiniApp.
// Pure-frontend 15x15 Gomoku with PvP + simple PvE AI; persists win stats via app.storage.

const SIZE = 15;
const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEWBOX = 600;
const PADDING = 24;
const STEP = (VIEWBOX - PADDING * 2) / (SIZE - 1);
const STAR_POINTS = [
  [3, 3], [3, 7], [3, 11],
  [7, 3], [7, 7], [7, 11],
  [11, 3], [11, 7], [11, 11],
];

const EMPTY = 0, BLACK = 1, WHITE = 2;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

const state = {
  board: createBoard(),
  history: [],
  current: BLACK,
  mode: 'pve', // 'pvp' | 'pve'
  winner: 0,
  winLine: null,
  hover: null,
  busy: false,
  stats: { black: 0, white: 0, ai: 0 },
};

const dom = {
  board: document.getElementById('board'),
  modeSeg: document.getElementById('mode-seg'),
  turnStone: document.getElementById('turn-stone'),
  turnName: document.getElementById('turn-name'),
  turnHint: document.getElementById('turn-hint'),
  btnUndo: document.getElementById('btn-undo'),
  btnRestart: document.getElementById('btn-restart'),
  history: document.getElementById('history'),
  statBlack: document.getElementById('stat-black'),
  statWhite: document.getElementById('stat-white'),
  statAi: document.getElementById('stat-ai'),
  statPveRow: document.getElementById('stat-pve-row'),
  resultOverlay: document.getElementById('result-overlay'),
  resultIcon: document.getElementById('result-icon'),
  resultTitle: document.getElementById('result-title'),
  resultSub: document.getElementById('result-sub'),
  resultRestart: document.getElementById('result-restart'),
};

function createBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
}

// ── Init ──────────────────────────────────────────────
async function init() {
  await loadStats();
  buildBoardSvg();
  bindEvents();
  render();
}

async function loadStats() {
  try {
    const v = await app.storage.get('stats');
    if (v && typeof v === 'object') {
      state.stats = { black: v.black | 0, white: v.white | 0, ai: v.ai | 0 };
    }
  } catch (_e) { /* ignore */ }
}

function persistStats() {
  app.storage.set('stats', state.stats).catch(() => {});
}

function buildBoardSvg() {
  const svg = dom.board;
  svg.innerHTML = '';

  const defs = el('defs');
  defs.innerHTML = `
    <radialGradient id="g-black" cx="35%" cy="32%" r="60%">
      <stop offset="0%" stop-color="#5a5a64"/>
      <stop offset="60%" stop-color="#1c1c20"/>
      <stop offset="100%" stop-color="#050507"/>
    </radialGradient>
    <radialGradient id="g-white" cx="35%" cy="32%" r="60%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="70%" stop-color="#e2e2e8"/>
      <stop offset="100%" stop-color="#b8b8c0"/>
    </radialGradient>
  `;
  svg.appendChild(defs);

  // Grid lines
  const grid = el('g', { class: 'grid' });
  for (let i = 0; i < SIZE; i++) {
    const p = PADDING + i * STEP;
    grid.appendChild(el('line', { class: 'grid-line', x1: PADDING, y1: p, x2: VIEWBOX - PADDING, y2: p }));
    grid.appendChild(el('line', { class: 'grid-line', x1: p, y1: PADDING, x2: p, y2: VIEWBOX - PADDING }));
  }
  // Star points
  for (const [r, c] of STAR_POINTS) {
    grid.appendChild(el('circle', { class: 'star', cx: PADDING + c * STEP, cy: PADDING + r * STEP, r: 3 }));
  }
  svg.appendChild(grid);

  // Stones layer
  const stones = el('g', { id: 'stones' });
  svg.appendChild(stones);
  // Markers layer (last move + win line)
  svg.appendChild(el('g', { id: 'markers' }));
  // Hover layer
  svg.appendChild(el('g', { id: 'hover' }));
}

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
  return node;
}

function bindEvents() {
  dom.modeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg__btn');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (!mode || mode === state.mode) return;
    state.mode = mode;
    for (const b of dom.modeSeg.querySelectorAll('.seg__btn')) {
      b.classList.toggle('is-active', b.dataset.mode === mode);
    }
    dom.statPveRow.hidden = mode !== 'pve';
    restart();
  });

  dom.btnUndo.addEventListener('click', undo);
  dom.btnRestart.addEventListener('click', restart);
  dom.resultRestart.addEventListener('click', restart);

  dom.board.addEventListener('mousemove', onHover);
  dom.board.addEventListener('mouseleave', () => { state.hover = null; renderHover(); });
  dom.board.addEventListener('click', onClick);
}

function pointFromEvent(e) {
  const rect = dom.board.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * VIEWBOX;
  const py = ((e.clientY - rect.top) / rect.height) * VIEWBOX;
  const c = Math.round((px - PADDING) / STEP);
  const r = Math.round((py - PADDING) / STEP);
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
  return { r, c };
}

function onHover(e) {
  if (state.winner || state.busy) { state.hover = null; renderHover(); return; }
  const p = pointFromEvent(e);
  if (!p || state.board[p.r][p.c] !== EMPTY) { state.hover = null; renderHover(); return; }
  if (state.hover && state.hover.r === p.r && state.hover.c === p.c) return;
  state.hover = p;
  renderHover();
}

function onClick(e) {
  if (state.winner || state.busy) return;
  const p = pointFromEvent(e);
  if (!p) return;
  if (state.board[p.r][p.c] !== EMPTY) return;
  placeStone(p.r, p.c, state.current);
  if (!state.winner && state.mode === 'pve' && state.current === WHITE) {
    state.busy = true;
    setTimeout(() => {
      const move = computeAiMove();
      if (move) placeStone(move.r, move.c, WHITE);
      state.busy = false;
      render();
    }, 240);
  }
}

function placeStone(r, c, color) {
  state.board[r][c] = color;
  state.history.push({ r, c, color });
  const win = checkWin(r, c, color);
  if (win) {
    state.winner = color;
    state.winLine = win;
    if (state.mode === 'pve') {
      if (color === BLACK) state.stats.black += 1;
      else state.stats.ai += 1;
    } else {
      if (color === BLACK) state.stats.black += 1;
      else state.stats.white += 1;
    }
    persistStats();
  } else {
    state.current = color === BLACK ? WHITE : BLACK;
  }
  state.hover = null;
  render();
}

function undo() {
  if (state.busy) return;
  if (state.winner) {
    // After a win, undo just resets current game without changing stats.
    restart();
    return;
  }
  if (state.history.length === 0) return;
  const popOnce = () => {
    const last = state.history.pop();
    if (!last) return;
    state.board[last.r][last.c] = EMPTY;
    state.current = last.color;
  };
  popOnce();
  // In PvE, undo two plies so the human moves again.
  if (state.mode === 'pve' && state.history.length > 0 && state.current === WHITE) {
    popOnce();
  }
  render();
}

function restart() {
  state.board = createBoard();
  state.history = [];
  state.current = BLACK;
  state.winner = 0;
  state.winLine = null;
  state.hover = null;
  state.busy = false;
  render();
}

// ── Win detection ─────────────────────────────────────
function checkWin(r, c, color) {
  for (const [dr, dc] of DIRS) {
    const line = [{ r, c }];
    for (let k = 1; k < 5; k++) {
      const nr = r + dr * k, nc = c + dc * k;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
      if (state.board[nr][nc] !== color) break;
      line.push({ r: nr, c: nc });
    }
    for (let k = 1; k < 5; k++) {
      const nr = r - dr * k, nc = c - dc * k;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
      if (state.board[nr][nc] !== color) break;
      line.unshift({ r: nr, c: nc });
    }
    if (line.length >= 5) return line.slice(0, 5);
  }
  return null;
}

// ── AI ────────────────────────────────────────────────
// Simple heuristic: score each empty cell by combining own threat + opponent threat.
function computeAiMove() {
  if (state.history.length === 0) return { r: 7, c: 7 };
  let best = null;
  let bestScore = -Infinity;
  const candidates = candidateCells();
  for (const { r, c } of candidates) {
    if (state.board[r][c] !== EMPTY) continue;
    const own = scoreAt(r, c, WHITE);
    const opp = scoreAt(r, c, BLACK) * 0.95;
    const center = -Math.abs(r - 7) - Math.abs(c - 7);
    const score = Math.max(own, opp) * 100 + (own + opp) + center;
    if (score > bestScore) { bestScore = score; best = { r, c }; }
  }
  return best;
}

function candidateCells() {
  const seen = new Set();
  const out = [];
  for (const m of state.history) {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const r = m.r + dr, c = m.c + dc;
        if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
        if (state.board[r][c] !== EMPTY) continue;
        const k = r * SIZE + c;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ r, c });
      }
    }
  }
  return out;
}

function scoreAt(r, c, color) {
  // Estimate the strongest pattern formed by placing `color` at (r,c).
  let best = 0;
  for (const [dr, dc] of DIRS) {
    let count = 1;
    let openA = false, openB = false;
    for (let k = 1; k < 5; k++) {
      const nr = r + dr * k, nc = c + dc * k;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
      const v = state.board[nr][nc];
      if (v === color) count += 1;
      else { if (v === EMPTY) openA = true; break; }
    }
    for (let k = 1; k < 5; k++) {
      const nr = r - dr * k, nc = c - dc * k;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
      const v = state.board[nr][nc];
      if (v === color) count += 1;
      else { if (v === EMPTY) openB = true; break; }
    }
    let s = 0;
    if (count >= 5) s = 100000;
    else if (count === 4) s = openA && openB ? 10000 : (openA || openB ? 1000 : 0);
    else if (count === 3) s = openA && openB ? 800 : (openA || openB ? 80 : 0);
    else if (count === 2) s = openA && openB ? 60 : (openA || openB ? 12 : 0);
    else if (count === 1) s = openA && openB ? 6 : 1;
    if (s > best) best = s;
  }
  return best;
}

// ── Render ────────────────────────────────────────────
function render() {
  renderStones();
  renderMarkers();
  renderHover();
  renderTurn();
  renderHistory();
  renderStats();
  renderResult();
  dom.btnUndo.disabled = state.history.length === 0 && !state.winner;
}

function renderStones() {
  const layer = dom.board.querySelector('#stones');
  layer.innerHTML = '';
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = state.board[r][c];
      if (v === EMPTY) continue;
      const cx = PADDING + c * STEP;
      const cy = PADDING + r * STEP;
      layer.appendChild(el('circle', {
        class: v === BLACK ? 'stone-black' : 'stone-white',
        cx, cy, r: STEP * 0.42,
      }));
    }
  }
}

function renderMarkers() {
  const layer = dom.board.querySelector('#markers');
  layer.innerHTML = '';
  const last = state.history[state.history.length - 1];
  if (last) {
    layer.appendChild(el('circle', {
      class: 'last-marker',
      cx: PADDING + last.c * STEP,
      cy: PADDING + last.r * STEP,
      r: STEP * 0.18,
    }));
  }
  if (state.winLine) {
    const a = state.winLine[0];
    const b = state.winLine[state.winLine.length - 1];
    layer.appendChild(el('line', {
      class: 'win-marker',
      x1: PADDING + a.c * STEP, y1: PADDING + a.r * STEP,
      x2: PADDING + b.c * STEP, y2: PADDING + b.r * STEP,
    }));
  }
}

function renderHover() {
  const layer = dom.board.querySelector('#hover');
  layer.innerHTML = '';
  if (!state.hover) return;
  if (state.winner || state.busy) return;
  layer.appendChild(el('circle', {
    class: 'hover-stone hover-stone--' + (state.current === BLACK ? 'black' : 'white'),
    cx: PADDING + state.hover.c * STEP,
    cy: PADDING + state.hover.r * STEP,
    r: STEP * 0.42,
  }));
}

function renderTurn() {
  const isWhite = state.current === WHITE;
  dom.turnStone.classList.toggle('is-white', isWhite);
  if (state.mode === 'pve') {
    dom.turnName.textContent = isWhite ? 'AI 思考中…' : '你（黑棋）';
    dom.turnHint.textContent = isWhite ? '请稍候' : '点击棋盘任意交叉点落子';
  } else {
    dom.turnName.textContent = isWhite ? '白棋' : '黑棋';
    dom.turnHint.textContent = '点击棋盘任意交叉点落子';
  }
}

function renderHistory() {
  if (state.history.length === 0) {
    dom.history.innerHTML = '<span class="history__empty">尚未落子</span>';
    return;
  }
  dom.history.innerHTML = '';
  state.history.forEach((m, i) => {
    const pill = document.createElement('span');
    pill.className = 'move-pill';
    const dot = document.createElement('span');
    dot.className = 'stone stone--mini ' + (m.color === BLACK ? 'stone--black' : 'stone--white');
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(`${i + 1} · ${columnLabel(m.c)}${SIZE - m.r}`));
    dom.history.appendChild(pill);
  });
  dom.history.scrollTop = dom.history.scrollHeight;
}

function columnLabel(c) {
  // A..O (skip I to follow Go convention? Keep simple A..O including I)
  return String.fromCharCode(65 + c);
}

function renderStats() {
  dom.statBlack.textContent = state.stats.black;
  dom.statWhite.textContent = state.stats.white;
  dom.statAi.textContent = state.stats.ai;
  dom.statPveRow.hidden = state.mode !== 'pve';
}

function renderResult() {
  if (!state.winner) { dom.resultOverlay.hidden = true; return; }
  dom.resultOverlay.hidden = false;
  const isBlack = state.winner === BLACK;
  if (state.mode === 'pve') {
    dom.resultTitle.textContent = isBlack ? '你赢了！' : 'AI 获胜';
    dom.resultSub.textContent = isBlack ? '稳如老 G' : '再战一局，把场子赢回来';
  } else {
    dom.resultTitle.textContent = isBlack ? '黑棋胜' : '白棋胜';
    dom.resultSub.textContent = '连成五子';
  }
  dom.resultIcon.textContent = isBlack ? '●' : '○';
  dom.resultIcon.style.color = '';
  dom.resultIcon.style.textShadow = '';
}

init();
