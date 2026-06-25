const api = new window.GameAPI();

const GAME_NAME = 'NoTeLaSabes';
const GAME_ID_FALLBACK = 14;
const USER_KEY = 'notelasabes_user';
const GAME_ID_KEY = 'notelasabes_game_id';
const SESSION_KEY = 'notelasabes_active_room';
const POLL_MS = 1400;
const DATA_BASES = [
  'https://jalonsomerchan.github.io/trivial-db',
  'https://raw.githubusercontent.com/jalonsomerchan/trivial-db/main'
];
const MODES = {
  all: ['🙋', 'Trivial a todos', 'Todos responden y suma quien acierte.', false],
  normal: ['🎯', 'Trivial normal', 'La pregunta va solo a una persona.', false],
  teams: ['👥', 'Trivial por equipos', 'Responde un equipo y cada acierto suma.', true],
  teams_majority: ['🗳️', 'Equipos: la mayoría', 'El equipo suma si la mayoría acierta.', true],
  teams_trust: ['🤝', 'Equipos: confiamos en ti', 'Solo responde un jugador del equipo.', true],
  know: ['🧠', 'Lo sabe / no lo sabe', 'Uno responde y el resto apuesta si lo sabe.', false]
};
const DEFAULT_SETTINGS = { mode: 'all', rounds: 12, roundSeconds: 35, allowPass: true, fastest: false, adminReads: false, categories: [], difficulties: [] };
const SCORE_RULES = {
  all: 'Correcta +2 · fallo 0', normal: 'Correcta +3 · fallo −1', teams: 'Cada acierto +1 al jugador y al equipo',
  teams_majority: 'Mayoría +3 al equipo', teams_trust: 'Acierto +3 · fallo −1', know: 'Persona +2/−1 · apuestas +1/−1'
};
const state = {
  user: null, gameId: Number(localStorage.getItem(GAME_ID_KEY) || GAME_ID_FALLBACK), room: null, hostId: '', isHost: false,
  players: [], settings: { ...DEFAULT_SETTINGS }, categories: [], questionIndex: [], gameQuestionIds: [], currentRound: 0,
  currentQuestion: null, round: null, answers: {}, predictions: {}, scores: {}, teamScores: { A: 0, B: 0 }, reveal: null,
  status: 'idle', selectedAnswer: null, timer: null, roundEndsAt: 0, pollTimer: null, questionCache: new Map()
};

const $ = id => document.getElementById(id);
const sid = () => String(state.user?.id || '');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, a, b) => Math.min(b, Math.max(a, Number(n || 0)));
const modeMeta = m => MODES[m] || MODES.all;
const isTeamMode = m => !!modeMeta(m)[3];
const teamName = t => t === 'A' ? 'Equipo Morado' : 'Equipo Amarillo';
const teamEmoji = t => t === 'A' ? '🟣' : '🟡';
const otherTeam = t => t === 'A' ? 'B' : 'A';
const playerById = id => state.players.find(p => String(p.id) === String(id));
const diffLabel = d => ({ easy: 'Fácil', medium: 'Media', hard: 'Difícil' }[d] || 'Media');
const titleCase = s => String(s || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}
function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(list, seed = Date.now()) {
  const arr = [...list], rnd = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
function shuffledAnswerOptions(question, playerId = sid()) {
  const options = (question?.answers || []).map((answer, answerIndex) => ({ answer, answerIndex }));
  return shuffle(options, hashString(`${question?.id || question?.question}:${state.currentRound}:${playerId || 'anon'}`));
}

function showScreen(name) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); $(`screen-${name}`)?.classList.add('active'); }
function toast(message, icon = '') {
  const el = $('toast'); if (!el) return;
  el.textContent = `${icon ? icon + ' ' : ''}${message}`; el.classList.remove('opacity-0'); el.classList.add('opacity-100');
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.classList.add('opacity-0'); el.classList.remove('opacity-100'); }, 2600);
}
function setBusy(btn, busy, text = 'Cargando…') {
  if (!btn) return; if (busy) { btn.dataset.text = btn.dataset.text || btn.textContent; btn.textContent = text; btn.disabled = true; btn.classList.add('opacity-60'); }
  else { btn.textContent = btn.dataset.text || btn.textContent; btn.disabled = false; btn.classList.remove('opacity-60'); }
}
async function fetchData(path) {
  let error;
  for (const base of DATA_BASES) {
    try {
      const url = `${base}/${path}`;
      const res = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) { error = e; }
  }
  throw error || new Error('No se pudo cargar ' + path);
}
async function loadCatalog() {
  $('catalog-status') && ($('catalog-status').textContent = 'Cargando preguntas de Trivial DB…');
  try {
    const [idx, cats] = await Promise.all([fetchData('index.json'), fetchData('categories.json').catch(() => ({ categories: [] }))]);
    state.questionIndex = (Array.isArray(idx) ? idx : []).map(q => ({ id: String(q.id || ''), question: String(q.question || '') })).filter(q => q.id);
    state.categories = (cats.categories || []).map(c => ({ id: String(c.id), name: c.name || titleCase(c.id), icon: c.icon || '❔', questions: (c.questions || []).map(String), stats: c.stats || {} })).filter(c => c.id);
    renderCategories();
    $('catalog-status') && ($('catalog-status').textContent = `${state.questionIndex.length.toLocaleString('es-ES')} preguntas · ${state.categories.length.toLocaleString('es-ES')} categorías`);
  } catch (e) { console.error(e); $('catalog-status') && ($('catalog-status').textContent = 'No se pudo cargar Trivial DB.'); }
}
async function loadQuestion(id) {
  if (state.questionCache.has(id)) return state.questionCache.get(id);
  const q = await fetchData(`questions/${id}.json`);
  const norm = { ...q, id: String(q.id || id), category: String(q.category || 'general'), difficulty: q.difficulty || 'medium', answers: (q.answers || []).map((a, i) => ({ id: String(i), text: String(a.text || a.answer || ''), correct: !!a.correct })).filter(a => a.text) };
  state.questionCache.set(id, norm); return norm;
}
function currentPlayer() { return { id: sid(), username: state.user?.username || 'Jugador', team: playerById(sid())?.team || 'A' }; }
function normalizePlayer(p = {}) { return { id: String(p.id ?? p.user_id ?? p.userId ?? p.username), username: String(p.username ?? p.name ?? 'Jugador'), team: p.team === 'B' ? 'B' : 'A' }; }
function upsertPlayer(p) { const n = normalizePlayer(p), i = state.players.findIndex(x => x.id === n.id); i >= 0 ? state.players[i] = { ...state.players[i], ...n } : state.players.push(n); state.scores[n.id] ??= 0; return n; }
function assignTeams(players = state.players) { return players.map((p, i) => ({ ...normalizePlayer(p), team: i % 2 ? 'B' : 'A' })); }
function roomCode(r) { return String(r?.code ?? r?.room_code ?? r?.room?.code ?? '').toUpperCase(); }
function roomId(r) { return r?.id ?? r?.room_id ?? r?.room?.id ?? null; }
function parseMaybe(v, fallback) { if (v == null || v === '') return fallback; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } } return v; }
function extractGameState(room = {}) { return parseMaybe(room.game_state ?? room.gameState ?? room.room?.game_state, {}); }
function extractSettings(room = {}) { return { ...DEFAULT_SETTINGS, ...parseMaybe(room.room_settings ?? room.roomSettings ?? room.room?.room_settings, {}) }; }
function normalizeRoom(room, fallback = '') { return { id: roomId(room), code: roomCode(room) || fallback }; }
function saveActive() { state.room?.code && localStorage.setItem(SESSION_KEY, JSON.stringify({ code: state.room.code, hostId: state.hostId })); }
function clearActive() { localStorage.removeItem(SESSION_KEY); }
function gameState(extra = {}) {
  return { hostId: state.hostId, players: state.players, settings: state.settings, gameQuestionIds: state.gameQuestionIds, currentRound: state.currentRound, currentQuestion: state.currentQuestion, round: state.round, answers: state.answers, predictions: state.predictions, scores: state.scores, teamScores: state.teamScores, reveal: state.reveal, status: state.status, roundEndsAt: state.roundEndsAt, ...extra };
}
function applyGameState(gs = {}) {
  if (!gs || typeof gs !== 'object') return;
  state.hostId = String(gs.hostId || state.hostId || ''); state.players = (gs.players || state.players || []).map(normalizePlayer); state.settings = { ...DEFAULT_SETTINGS, ...state.settings, ...(gs.settings || {}) };
  ['gameQuestionIds','currentRound','currentQuestion','round','answers','predictions','scores','teamScores','reveal','status','roundEndsAt'].forEach(k => { if (gs[k] !== undefined) state[k] = gs[k]; });
  state.isHost = sid() && sid() === state.hostId; applySettingsToUI();
}
async function saveRoom() { if (!state.room?.code) return; await api.updateRoomState(state.room.code, { gameState: gameState(), status: state.status, roomSettings: state.settings }).catch(e => console.warn(e)); }
async function mergeAndSave(mutator) {
  if (!state.room?.code) return;
  try { applyGameState(extractGameState(await api.getRoom(state.room.code))); } catch {}
  mutator?.(); await saveRoom(); routeByStatus();
}
function startPolling(code) { clearInterval(state.pollTimer); state.pollTimer = setInterval(() => refreshRoom(code), POLL_MS); refreshRoom(code); }
async function refreshRoom(code = state.room?.code) {
  if (!code) return;
  try { const room = await api.getRoom(code); applyGameState(extractGameState(room)); if (!state.hostId) state.hostId = String(room.host_id ?? room.hostId ?? state.hostId); routeByStatus(); }
  catch (e) { console.warn('poll', e); }
}
function syncSettingsFromUI() {
  state.settings = { ...state.settings,
    rounds: clamp($('cfg-rounds')?.value || 12, 3, 60), roundSeconds: clamp($('cfg-time')?.value || 35, 10, 180),
    allowPass: !!$('cfg-pass')?.checked, fastest: !!$('cfg-fastest')?.checked, adminReads: !!$('cfg-admin-reads')?.checked,
    categories: [...document.querySelectorAll('#category-list input:checked')].map(i => i.value),
    difficulties: [...document.querySelectorAll('.difficulty-filter:checked')].map(i => i.value)
  };
  renderModeList(); updateCategoryCount();
}
function applySettingsToUI() {
  $('cfg-rounds') && ($('cfg-rounds').value = state.settings.rounds || 12); $('cfg-time') && ($('cfg-time').value = state.settings.roundSeconds || 35);
  $('cfg-pass') && ($('cfg-pass').checked = !!state.settings.allowPass); $('cfg-fastest') && ($('cfg-fastest').checked = !!state.settings.fastest); $('cfg-admin-reads') && ($('cfg-admin-reads').checked = !!state.settings.adminReads);
  document.querySelectorAll('#category-list input').forEach(i => i.checked = (state.settings.categories || []).includes(i.value));
  document.querySelectorAll('.difficulty-filter').forEach(i => i.checked = (state.settings.difficulties || []).includes(i.value));
  renderModeList(); updateCategoryCount();
}
function renderModeList() {
  const root = $('mode-list'); if (!root) return;
  root.innerHTML = Object.entries(MODES).map(([key, m]) => `<button type="button" onclick="App.selectMode('${key}')" class="mode-card ${state.settings.mode === key ? 'active' : ''} rounded-2xl p-3 text-left"><span class="text-2xl">${m[0]}</span><span class="block text-sm font-black mt-1">${m[1]}</span><span class="block text-[11px] text-violet-100/50 mt-1">${m[2]}</span></button>`).join('');
}
function renderCategories() {
  const root = $('category-list'); if (!root) return;
  root.innerHTML = state.categories.map(c => `<label data-category-name="${esc((c.name + ' ' + c.id).toLowerCase())}" class="category-pill cursor-pointer rounded-2xl border border-white/10 px-3 py-2.5 text-xs font-bold text-violet-100/75 transition"><input type="checkbox" class="sr-only" value="${esc(c.id)}" onchange="App.syncSettings()"><span class="category-check w-5 h-5 rounded-full bg-white/10 flex items-center justify-center text-[11px] font-black">✓</span><span>${c.icon} ${esc(c.name)}</span></label>`).join('');
  applySettingsToUI();
}
function updateCategoryCount() { const n = state.settings.categories?.length || 0; $('category-count') && ($('category-count').textContent = n ? `${n} elegidas` : 'Todas'); }
function renderWaiting() {
  showScreen('waiting'); $('waiting-code') && ($('waiting-code').textContent = state.room?.code || '—'); $('waiting-count') && ($('waiting-count').textContent = String(state.players.length));
  $('admin-settings')?.classList.toggle('opacity-50', !!state.room && !state.isHost); $('start-button')?.classList.toggle('hidden', !state.isHost); $('guest-wait')?.classList.toggle('hidden', state.isHost);
  $('team-help') && ($('team-help').textContent = isTeamMode(state.settings.mode) ? 'Equipos auto' : 'Individual');
  const root = $('waiting-players'); if (root) root.innerHTML = state.players.map(p => `<div class="panel rounded-2xl p-3 flex items-center gap-3"><div class="w-10 h-10 rounded-2xl bg-white/10 flex items-center justify-center font-black">${esc(p.username[0] || '?').toUpperCase()}</div><div class="flex-1"><p class="font-black">${esc(p.username)} ${p.id === sid() ? '<span class="text-xs text-brand-light">Tú</span>' : ''}</p><p class="text-xs text-violet-100/45">${isTeamMode(state.settings.mode) ? teamEmoji(p.team) + ' ' + teamName(p.team) : 'Jugador'}</p></div>${p.id === state.hostId ? '<span class="text-xs font-black text-quiz-amber">ADMIN</span>' : ''}</div>`).join('');
}
function categoryMeta(q) { const c = state.categories.find(x => x.id === q?.category); return { name: c?.name || titleCase(q?.category || 'General'), icon: c?.icon || '❔' }; }
function candidateResponderIds(baseRound = state.round) { return baseRound?.candidateResponderIds?.length ? baseRound.candidateResponderIds.map(String) : baseRound?.activeResponderIds?.length ? baseRound.activeResponderIds.map(String) : []; }
function activeResponderIds() { return (state.round?.activeResponderIds || []).map(String); }
function predictionIds() { return (state.round?.predictorIds || []).map(String); }
function hasMyAnswer() { return !!state.answers?.[sid()]; }
function hasMyPrediction() { return !!state.predictions?.[sid()]; }
function allRequiredDone() {
  if (state.settings.fastest && state.round?.buzzerOpen && !state.round?.buzzerWinnerId && !state.round?.challenge && state.settings.mode !== 'know') return false;
  return activeResponderIds().every(id => state.answers?.[id]) && predictionIds().every(id => state.predictions?.[id]);
}
function targetText() {
  const r = state.round || {}, mode = state.settings.mode;
  if (r.challenge) return `Reto para ${playerById(r.challenge.challengeeId)?.username || 'otro jugador'}`;
  if (mode === 'all') return state.settings.fastest && r.buzzerOpen ? 'Pulsa para responder' : 'Pregunta para todos';
  if (mode === 'know') return `${playerById(r.targetPlayerId)?.username || 'Alguien'} responde · el resto apuesta`;
  if (isTeamMode(mode)) return `${teamEmoji(r.targetTeam)} ${teamName(r.targetTeam)}`;
  return `Turno de ${playerById(r.targetPlayerId)?.username || 'jugador'}`;
}
function getQuestionNote() {
  const mode = state.settings.mode, score = SCORE_RULES[mode] || '';
  if (state.round?.challenge) return 'Reto doble: si falla, gana quien pasó; si acierta, gana el retado.';
  if (state.settings.fastest && state.round?.buzzerOpen && mode !== 'know') return 'Primero pulsa, después responde.';
  return score;
}
function tickTimer() {
  const total = state.settings.roundSeconds || 35, leftMs = Math.max(0, Number(state.roundEndsAt || 0) - Date.now()), left = Math.ceil(leftMs / 1000);
  $('timer-label') && ($('timer-label').textContent = String(left)); $('timer-bar') && ($('timer-bar').style.width = `${Math.max(0, Math.min(100, leftMs / 1000 / total * 100))}%`);
  $('timer-label')?.classList.toggle('pulse-timer', left <= 8);
  if (left <= 0 && state.status === 'playing') { clearInterval(state.timer); if (state.isHost) App.revealRound(); }
}
function renderGame() {
  showScreen('game'); clearInterval(state.timer); tickTimer(); state.timer = setInterval(tickTimer, 250);
  const q = state.currentQuestion || {}, meta = categoryMeta(q), hide = state.settings.adminReads && !state.isHost;
  $('game-round') && ($('game-round').textContent = String(Number(state.currentRound || 0) + 1)); $('game-total') && ($('game-total').textContent = String(state.settings.rounds || 12)); $('game-mode-label') && ($('game-mode-label').textContent = modeMeta(state.settings.mode)[1]);
  $('question-category') && ($('question-category').textContent = `${meta.icon} ${meta.name}`); $('question-difficulty') && ($('question-difficulty').textContent = diffLabel(q.difficulty)); $('admin-read-badge')?.classList.toggle('hidden', !hide);
  $('target-title') && ($('target-title').textContent = targetText()); $('question-text') && ($('question-text').textContent = hide ? 'Pregunta leída por el anfitrión' : q.question || 'Pregunta'); $('question-note') && ($('question-note').textContent = getQuestionNote());
  renderBuzzer(); renderAnswers(); renderPredictions(); renderPassButton(); renderScores();
}
function renderBuzzer() {
  const show = !!(state.settings.fastest && state.settings.mode !== 'know' && state.round?.buzzerOpen && !state.round?.buzzerWinnerId && !state.round?.challenge);
  $('buzzer-panel')?.classList.toggle('hidden', !show); const can = show && candidateResponderIds().includes(sid()); $('buzzer-button') && ($('buzzer-button').disabled = !can); $('buzzer-status') && ($('buzzer-status').textContent = can ? 'Puedes pulsar.' : 'No entras en este turno.');
}
function renderAnswers() {
  const root = $('answers-grid'); if (!root) return; const myTurn = activeResponderIds().includes(sid()), disabled = !myTurn || hasMyAnswer() || state.status !== 'playing';
  const hide = state.settings.fastest && state.round?.buzzerOpen && !state.round?.buzzerWinnerId && !state.round?.challenge && state.settings.mode !== 'know'; root.classList.toggle('hidden', hide);
  root.innerHTML = shuffledAnswerOptions(state.currentQuestion).map(({ answer, answerIndex }, i) => `<button type="button" class="btn-answer rounded-[1.5rem] p-5 text-left ${state.selectedAnswer === answerIndex ? 'selected' : ''}" ${disabled ? 'disabled' : ''} onclick="App.submitAnswer(${answerIndex})"><span class="text-xs font-black text-brand-light uppercase tracking-widest">${String.fromCharCode(65 + i)}</span><span class="block text-lg sm:text-xl font-black mt-1">${esc(answer.text)}</span></button>`).join('');
  $('player-status') && ($('player-status').textContent = myTurn ? (hasMyAnswer() ? 'Respuesta enviada.' : 'Te toca responder.') : predictionIds().includes(sid()) ? 'Apuesta si crees que lo sabe.' : 'Espera tu turno.');
}
function renderPredictions() { const show = state.settings.mode === 'know' && predictionIds().includes(sid()) && !hasMyPrediction(); $('prediction-grid')?.classList.toggle('hidden', !show); }
function renderPassButton() { const can = state.settings.allowPass && !state.round?.challenge && activeResponderIds().includes(sid()) && !hasMyAnswer() && state.players.length > 1; $('pass-panel')?.classList.toggle('hidden', !can); }
function renderScores() {
  const root = $('score-strip'); if (!root) return;
  const rows = state.players.map(p => ({ ...p, score: Number(state.scores[p.id] || 0) })).sort((a,b) => b.score - a.score);
  root.innerHTML = rows.map((p, i) => `<div class="panel rounded-2xl p-3 flex items-center gap-3"><span class="w-7 text-center font-black text-violet-100/45">#${i+1}</span><span class="flex-1 font-black truncate">${esc(p.username)}</span><span class="text-xl font-black text-gradient">${p.score}</span></div>`).join('');
}
function pickQuestionIds() {
  let ids = [];
  const cats = new Set(state.settings.categories || []);
  if (cats.size) ids = state.categories.filter(c => cats.has(c.id)).flatMap(c => c.questions || []);
  if (!ids.length) ids = state.questionIndex.map(q => q.id);
  return shuffle([...new Set(ids)], hashString(`${Date.now()}:${state.players.map(p => p.id).join('-')}`)).slice(0, Math.max(3, state.settings.rounds * 3));
}
async function nextValidQuestion(fromIndex = 0) {
  const diffs = new Set(state.settings.difficulties || []);
  for (let i = fromIndex; i < state.gameQuestionIds.length; i++) { const q = await loadQuestion(state.gameQuestionIds[i]); if (q?.answers?.length >= 2 && (!diffs.size || diffs.has(q.difficulty))) return { index: i, question: q }; }
  return null;
}
function buildRound(i) {
  const mode = state.settings.mode, players = state.players, r = { mode, challenge: null, buzzerWinnerId: null, buzzerOpen: false, targetPlayerId: null, targetTeam: null, activeResponderIds: [], candidateResponderIds: [], predictorIds: [] };
  if (mode === 'all') r.candidateResponderIds = players.map(p => p.id);
  else if (mode === 'normal' || mode === 'know') { r.targetPlayerId = players[i % players.length]?.id; r.candidateResponderIds = [r.targetPlayerId]; }
  else { r.targetTeam = i % 2 ? 'B' : 'A'; const teamPlayers = players.filter(p => p.team === r.targetTeam); r.candidateResponderIds = mode === 'teams_trust' ? [teamPlayers[i % Math.max(1, teamPlayers.length)]?.id].filter(Boolean) : teamPlayers.map(p => p.id); }
  if (mode === 'know') { r.activeResponderIds = [r.targetPlayerId].filter(Boolean); r.predictorIds = players.filter(p => p.id !== r.targetPlayerId).map(p => p.id); }
  else if (state.settings.fastest) { r.buzzerOpen = true; r.activeResponderIds = []; }
  else r.activeResponderIds = r.candidateResponderIds;
  return r;
}
function chooseChallengee(challengerId) {
  const me = playerById(challengerId); let candidates = state.players.filter(p => p.id !== challengerId);
  if (isTeamMode(state.settings.mode) && me?.team) candidates = candidates.filter(p => p.team === otherTeam(me.team));
  if (!candidates.length) return null; return candidates[Math.floor(Math.random() * candidates.length)].id;
}
function addScore(scores, id, n) { scores[id] = Number(scores[id] || 0) + Number(n || 0); }
function addTeam(teamScores, idOrTeam, n) { const t = ['A','B'].includes(idOrTeam) ? idOrTeam : playerById(idOrTeam)?.team; if (t) teamScores[t] = Number(teamScores[t] || 0) + Number(n || 0); }
function calculateReveal() {
  const q = state.currentQuestion, correctIndex = q.answers.findIndex(a => a.correct), rows = state.players.map(p => { const a = state.answers[p.id], pr = state.predictions[p.id], ok = Number(a?.answerIndex) === correctIndex; return { player: p, answer: a, prediction: pr, correct: ok, points: 0, note: '' }; });
  const scores = { ...state.scores }, teamScores = { ...state.teamScores }; let winners = [], teamOutcome = '';
  if (state.round?.challenge) {
    const { challengerId, challengeeId } = state.round.challenge, ok = Number(state.answers[challengeeId]?.answerIndex) === correctIndex;
    if (ok) { addScore(scores, challengeeId, 4); addTeam(teamScores, challengeeId, 4); winners = [challengeeId]; teamOutcome = `${playerById(challengeeId)?.username} acierta el reto doble.`; }
    else { addScore(scores, challengerId, 4); addTeam(teamScores, challengerId, 4); winners = [challengerId]; teamOutcome = `${playerById(challengeeId)?.username || 'El retado'} falla: punto doble para quien pasó.`; }
    rows.forEach(r => { if (winners.includes(r.player.id)) { r.points = 4; r.note = 'Reto doble'; } });
  } else if (state.settings.mode === 'all') {
    rows.forEach(r => { if (r.answer && r.correct) { r.points = 2; r.note = 'Correcta'; addScore(scores, r.player.id, 2); winners.push(r.player.id); } });
  } else if (state.settings.mode === 'normal' || state.settings.mode === 'teams_trust') {
    activeResponderIds().forEach(id => { const row = rows.find(r => r.player.id === id); if (!row) return; const pts = row.correct ? 3 : -1; row.points = pts; row.note = row.correct ? 'Correcta' : 'Fallo'; addScore(scores, id, pts); addTeam(teamScores, id, pts); if (row.correct) winners.push(id); });
  } else if (state.settings.mode === 'teams') {
    activeResponderIds().forEach(id => { const row = rows.find(r => r.player.id === id); if (row?.correct) { row.points = 1; row.note = 'Acierto de equipo'; addScore(scores, id, 1); addTeam(teamScores, id, 1); winners.push(id); } });
  } else if (state.settings.mode === 'teams_majority') {
    const ids = activeResponderIds(), oks = ids.filter(id => rows.find(r => r.player.id === id)?.correct).length, team = state.round.targetTeam;
    if (oks > ids.length / 2) { addTeam(teamScores, team, 3); winners = ids; teamOutcome = `${teamName(team)} consigue mayoría.`; rows.forEach(r => { if (ids.includes(r.player.id) && r.correct) { r.points = 1; addScore(scores, r.player.id, 1); r.note = 'Mayoría'; } }); }
    else { addTeam(teamScores, team, -1); teamOutcome = `${teamName(team)} no consigue mayoría.`; }
  } else if (state.settings.mode === 'know') {
    const target = state.round.targetPlayerId, targetCorrect = !!rows.find(r => r.player.id === target)?.correct;
    rows.forEach(r => { if (r.player.id === target) { const pts = targetCorrect ? 2 : -1; r.points = pts; r.note = targetCorrect ? 'Respondió bien' : 'Falló'; addScore(scores, r.player.id, pts); if (targetCorrect) winners.push(r.player.id); } else if (r.prediction) { const pts = Boolean(r.prediction.thinksKnows) === targetCorrect ? 1 : -1; r.points = pts; r.note = pts > 0 ? 'Apuesta acertada' : 'Apuesta fallada'; addScore(scores, r.player.id, pts); if (pts > 0) winners.push(r.player.id); } });
  }
  return { question: q, correctIndex, correctText: q.answers[correctIndex]?.text || '—', rows, scores, teamScores, winners: [...new Set(winners)], teamOutcome };
}
function renderReveal() {
  showScreen('reveal'); clearInterval(state.timer); const r = state.reveal; if (!r) return;
  $('reveal-question') && ($('reveal-question').textContent = r.question.question); $('reveal-answer') && ($('reveal-answer').textContent = r.correctText); $('reveal-explanation') && ($('reveal-explanation').textContent = r.question.explanation || ''); $('round-rule') && ($('round-rule').textContent = SCORE_RULES[state.settings.mode] || 'Resultado');
  const winners = r.winners.map(playerById).filter(Boolean); $('round-winner-box') && ($('round-winner-box').innerHTML = `<p class="text-xs text-brand-light font-black uppercase tracking-widest">Ganador${winners.length > 1 ? 'es' : ''}</p><div class="text-5xl my-2">${winners.length > 1 ? '🤝' : '👑'}</div><p class="text-3xl font-black text-gradient">${winners.map(p => esc(p.username)).join(' + ') || 'Sin ganador'}</p><p class="text-xs text-violet-100/55 mt-2">${esc(r.teamOutcome || 'Ronda calculada')}</p>`);
  $('team-round-box') && ($('team-round-box').innerHTML = isTeamMode(state.settings.mode) ? `<div class="panel rounded-2xl p-4 font-black">${teamEmoji('A')} ${state.teamScores.A || 0} · ${teamEmoji('B')} ${state.teamScores.B || 0}</div>` : '');
  $('reveal-results') && ($('reveal-results').innerHTML = r.rows.map(row => `<div class="panel rounded-2xl p-3 flex items-center gap-3"><div class="flex-1"><p class="font-black">${esc(row.player.username)}</p><p class="text-xs text-violet-100/45">${row.answer ? esc(r.question.answers[row.answer.answerIndex]?.text || '—') : row.prediction ? (row.prediction.thinksKnows ? 'Apostó: lo sabe' : 'Apostó: no lo sabe') : 'Sin respuesta'}</p></div><div class="text-right"><p class="font-black ${row.correct ? 'text-quiz-green' : 'text-quiz-pink'}">${row.correct ? 'Bien' : row.answer ? 'Mal' : '—'}</p><p class="text-xl font-black text-gradient">${row.points > 0 ? '+' : ''}${row.points}</p></div></div>`).join(''));
  $('next-round-button')?.classList.toggle('hidden', !state.isHost); $('guest-next-wait')?.classList.toggle('hidden', state.isHost);
}
function renderFinal() {
  showScreen('final'); launchConfetti('final-confetti', 120); const rows = state.players.map(p => ({ ...p, score: Number(state.scores[p.id] || 0) })).sort((a,b) => b.score - a.score), best = rows[0]?.score ?? 0, winners = rows.filter(p => p.score === best);
  $('final-winner') && ($('final-winner').textContent = winners.map(p => p.username).join(' + ') || '—'); $('final-scores') && ($('final-scores').innerHTML = rows.map((p,i) => `<div class="${i===0?'winner-card bg-brand/20 border-brand-light/40':'panel'} rounded-2xl p-3 flex items-center gap-3 border border-white/10"><span class="w-8 text-center font-black text-violet-100/45">#${i+1}</span><span class="flex-1 text-left font-black">${esc(p.username)}</span><span class="text-2xl font-black text-gradient">${p.score}</span></div>`).join(''));
  $('final-team-scores') && ($('final-team-scores').innerHTML = isTeamMode(state.settings.mode) ? `<div class="panel rounded-2xl p-4 font-black">${teamEmoji('A')} ${teamName('A')}: ${state.teamScores.A || 0}<br>${teamEmoji('B')} ${teamName('B')}: ${state.teamScores.B || 0}</div>` : '');
  $('new-game-button')?.classList.toggle('hidden', !state.isHost); $('guest-final-wait')?.classList.toggle('hidden', state.isHost);
}
function routeByStatus() { if (state.status === 'waiting' || state.status === 'idle') renderWaiting(); else if (state.status === 'playing') renderGame(); else if (state.status === 'reveal') renderReveal(); else if (state.status === 'finished') renderFinal(); }
function launchConfetti(id = 'confetti-container', count = 90) { const root = $(id); if (!root) return; root.innerHTML = ''; const colors = ['#7C3AED','#C4B5FD','#FB7185','#FACC15','#34D399','#38BDF8']; for (let i=0;i<count;i++){ const d=document.createElement('div'); d.className='confetti-piece'; d.style.left=Math.random()*100+'vw'; d.style.width=d.style.height=5+Math.random()*9+'px'; d.style.background=colors[i%colors.length]; d.style.animationDuration=2+Math.random()*3+'s'; d.style.animationDelay=Math.random()*.7+'s'; root.appendChild(d); } setTimeout(()=>root.innerHTML='',6000); }
async function prepareUser() {
  const username = ($('input-username')?.value || state.user?.username || '').trim(); if (username.length < 2) { $('login-error') && ($('login-error').textContent = 'Pon un nombre de al menos 2 caracteres.'); $('login-error')?.classList.remove('hidden'); return false; }
  if (state.user?.id && state.user.username === username) return true;
  try { const res = await api.createUser(username, GAME_NAME, ''); state.user = { id: String(res.user_id ?? res.id ?? res.user?.id), username }; }
  catch { state.user = { id: 'local-' + Math.random().toString(36).slice(2), username }; toast('Jugador local creado.', '⚠️'); }
  localStorage.setItem(USER_KEY, JSON.stringify(state.user)); $('switch-user')?.classList.remove('hidden'); return true;
}
function restoreUser() { try { const u = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); if (u?.id) { state.user = u; $('input-username') && ($('input-username').value = u.username); $('switch-user')?.classList.remove('hidden'); } } catch {} }
function getShareUrl() { return `${location.origin}${location.pathname}?sala=${encodeURIComponent(state.room?.code || '')}`; }
function renderQR(url) { const r = $('qr-container'); if (r) r.innerHTML = `<img class="rounded-2xl" width="220" height="220" alt="QR" src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(url)}">`; }
window.App = {
  async init() { restoreUser(); renderModeList(); document.querySelectorAll('#admin-settings input').forEach(i => i.addEventListener('change', App.syncSettings)); await loadCatalog(); const code = new URLSearchParams(location.search).get('sala') || new URLSearchParams(location.search).get('room'); if (code) { App.showJoinForm(); $('input-room-code') && ($('input-room-code').value = code.toUpperCase()); } },
  async createHomeRoom() { const btn = $('btn-create-room'); setBusy(btn,true,'Creando…'); try { if (!(await prepareUser())) return; syncSettingsFromUI(); state.hostId=sid(); state.isHost=true; state.players=[currentPlayer()]; state.scores={ [sid()]:0 }; state.status='waiting'; const room = await api.createRoom(state.gameId, sid(), state.settings, gameState({status:'waiting'})); state.room=normalizeRoom(room); saveActive(); await saveRoom(); startPolling(state.room.code); renderWaiting(); toast('Sala creada','✅'); } catch(e){ console.error(e); toast('No se pudo crear la sala','⚠️'); } finally { setBusy(btn,false); } },
  async showJoinForm() { await prepareUser().catch(()=>{}); $('join-container')?.classList.remove('hidden'); $('login-actions')?.classList.add('hidden'); },
  hideJoinForm() { $('join-container')?.classList.add('hidden'); $('login-actions')?.classList.remove('hidden'); },
  async joinHomeRoom() { const code = ($('input-room-code')?.value || '').trim().toUpperCase(); if (!(await prepareUser()) || !code) return; try { const room = await api.getRoom(code); state.room=normalizeRoom(room, code); state.settings=extractSettings(room); applyGameState(extractGameState(room)); if (!state.hostId) state.hostId = String(room.host_id ?? room.hostId ?? state.hostId); state.isHost=sid()===state.hostId; await api.joinRoom(code,sid()).catch(()=>{}); upsertPlayer({ ...currentPlayer(), team: state.players.length % 2 ? 'B':'A' }); await saveRoom(); saveActive(); startPolling(code); renderWaiting(); toast('Dentro de la sala','✅'); } catch(e){ console.error(e); $('join-error') && ($('join-error').textContent='No se pudo entrar en la sala.'); $('join-error')?.classList.remove('hidden'); } },
  async startGame() { if (!state.isHost) return; syncSettingsFromUI(); if (isTeamMode(state.settings.mode) && state.players.length < 2) return toast('Hacen falta al menos 2 jugadores.','⚠️'); state.players=assignTeams(); state.gameQuestionIds=pickQuestionIds(); const next=await nextValidQuestion(0); if(!next) return toast('No hay preguntas válidas.','⚠️'); Object.assign(state,{ currentRound:next.index, currentQuestion:next.question, round:buildRound(next.index), answers:{}, predictions:{}, reveal:null, scores:Object.fromEntries(state.players.map(p=>[p.id,0])), teamScores:{A:0,B:0}, status:'playing', roundEndsAt:Date.now()+state.settings.roundSeconds*1000 }); await saveRoom(); renderGame(); },
  async submitAnswer(answerIndex) { if (state.status!=='playing' || !activeResponderIds().includes(sid()) || hasMyAnswer()) return; const answer={ answerIndex:Number(answerIndex), at:Date.now(), questionId:state.currentQuestion?.id }; state.selectedAnswer=Number(answerIndex); await mergeAndSave(()=>{ state.answers={...state.answers,[sid()]:answer}; }); if(state.isHost && allRequiredDone()) setTimeout(()=>App.revealRound(),120); },
  async submitPrediction(thinksKnows) { if (state.status!=='playing' || !predictionIds().includes(sid()) || hasMyPrediction()) return; await mergeAndSave(()=>{ state.predictions={...state.predictions,[sid()]:{ thinksKnows:!!thinksKnows, at:Date.now(), targetPlayerId:state.round?.targetPlayerId }}; }); if(state.isHost && allRequiredDone()) setTimeout(()=>App.revealRound(),120); },
  async hitBuzzer() { if(!state.settings.fastest || state.round?.buzzerWinnerId || !candidateResponderIds().includes(sid())) return; await mergeAndSave(()=>{ if(!state.round.buzzerWinnerId){ state.round={...state.round,buzzerWinnerId:sid(),buzzerOpen:false,activeResponderIds:[sid()]}; }}); },
  async passQuestion() { if(!state.settings.allowPass || state.round?.challenge || !activeResponderIds().includes(sid())) return; const id=chooseChallengee(sid()); if(!id) return toast('No hay rival disponible.','⚠️'); await mergeAndSave(()=>{ state.answers={}; state.predictions={}; state.round={...state.round,challenge:{challengerId:sid(),challengeeId:id},activeResponderIds:[id],predictorIds:[],buzzerOpen:false,buzzerWinnerId:null}; state.roundEndsAt=Date.now()+state.settings.roundSeconds*1000; }); toast(`Pregunta pasada a ${playerById(id)?.username || 'otro jugador'}`,'🎯'); },
  async revealRound() { if(!state.isHost || state.status!=='playing') return; state.reveal=calculateReveal(); state.scores=state.reveal.scores; state.teamScores=state.reveal.teamScores; state.status='reveal'; await saveRoom(); renderReveal(); launchConfetti(); },
  async nextRound() { if(!state.isHost) return; const next=await nextValidQuestion(Number(state.currentRound)+1); if(!next){ state.status='finished'; await saveRoom(); return renderFinal(); } Object.assign(state,{ currentRound:next.index,currentQuestion:next.question,round:buildRound(next.index),answers:{},predictions:{},reveal:null,selectedAnswer:null,status:'playing',roundEndsAt:Date.now()+state.settings.roundSeconds*1000 }); await saveRoom(); renderGame(); },
  async newGame() { if(!state.isHost) return; Object.assign(state,{ status:'waiting',answers:{},predictions:{},reveal:null,round:null,currentQuestion:null,currentRound:0,gameQuestionIds:[],scores:Object.fromEntries(state.players.map(p=>[p.id,0])),teamScores:{A:0,B:0} }); await saveRoom(); renderWaiting(); },
  selectMode(mode) { if(!MODES[mode] || (!state.isHost && state.room)) return; state.settings.mode=mode; App.syncSettings(); },
  adjustSetting(key,delta){ const map={rounds:['cfg-rounds',3,60],roundSeconds:['cfg-time',10,180]}, [id,min,max]=map[key]||[]; if(!id) return; $(id).value=clamp(Number($(id).value||0)+delta,min,max); App.syncSettings(); },
  syncSettings(){ if(!state.isHost && state.room) return; syncSettingsFromUI(); state.room?.code && saveRoom(); },
  clearCategories(){ document.querySelectorAll('#category-list input').forEach(i=>i.checked=false); App.syncSettings(); }, focusCategories(){ $('category-search')?.focus(); },
  filterCategories(v){ const q=String(v||'').toLowerCase(); document.querySelectorAll('#category-list [data-category-name]').forEach(el=>el.classList.toggle('hidden', q && !el.dataset.categoryName.includes(q))); },
  openShareModal(){ if(!state.room?.code) return; const url=getShareUrl(); $('share-code') && ($('share-code').textContent=state.room.code); $('share-link') && ($('share-link').value=url); renderQR(url); $('share-modal')?.classList.remove('hidden'); $('share-modal')?.classList.add('flex'); }, closeShareModal(){ $('share-modal')?.classList.add('hidden'); $('share-modal')?.classList.remove('flex'); },
  async copyShareLink(){ const url=getShareUrl(); try{ await navigator.clipboard.writeText(url); }catch{ $('share-link')?.select(); document.execCommand('copy'); } toast('Enlace copiado','✅'); },
  async nativeShare(){ const url=getShareUrl(); if(navigator.share) { try{ await navigator.share({title:'No te la sabes',text:`Únete a mi sala ${state.room?.code}`,url}); }catch{} } else App.copyShareLink(); },
  switchUser(){ localStorage.removeItem(USER_KEY); clearActive(); state.user=null; $('input-username') && ($('input-username').value=''); showScreen('login'); },
  exitToHome(){ clearInterval(state.pollTimer); clearInterval(state.timer); clearActive(); state.room=null; state.status='idle'; state.isHost=false; showScreen('login'); }
};
window.addEventListener('beforeunload', () => { clearInterval(state.pollTimer); clearInterval(state.timer); });
window.addEventListener('DOMContentLoaded', () => App.init());
