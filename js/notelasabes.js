const api = new window.GameAPI();

const GAME_NAME = 'NoTeLaSabes';
const GAME_ID_FALLBACK = 14;
const USER_KEY = 'notelasabes_user';
const GAME_ID_KEY = 'notelasabes_game_id';
const SESSION_KEY = 'notelasabes_active_room';
const POLL_MS = 1400;
const SOCKET_RECONNECT_MS = 1800;
const SOCKET_MAX_RETRIES = 6;
const DATA_BASES = [
  'https://jalonsomerchan.github.io/trivial-db',
  'https://raw.githubusercontent.com/jalonsomerchan/trivial-db/main'
];

const MODES = {
  all: {
    label: 'Trivial a todos',
    short: 'A todos',
    icon: '🙋',
    description: 'Todos responden la misma pregunta y suma quien acierte.',
    team: false
  },
  normal: {
    label: 'Trivial normal',
    short: 'Normal',
    icon: '🎯',
    description: 'La pregunta va dirigida solo a una persona.',
    team: false
  },
  teams: {
    label: 'Trivial por equipos',
    short: 'Equipos',
    icon: '👥',
    description: 'Responde un equipo y cada acierto suma.',
    team: true
  },
  teams_majority: {
    label: 'Equipos: la mayoría',
    short: 'Mayoría',
    icon: '🗳️',
    description: 'El equipo suma si la mayoría acierta.',
    team: true
  },
  teams_trust: {
    label: 'Equipos: confiamos en ti',
    short: 'Confiamos',
    icon: '🤝',
    description: 'Solo responde una persona del equipo.',
    team: true
  },
  know: {
    label: 'Lo sabe / no lo sabe',
    short: 'Lo sabe',
    icon: '🧠',
    description: 'Uno responde y los demás apuestan si la sabe.',
    team: false
  }
};

const DEFAULT_SETTINGS = {
  mode: 'all',
  rounds: 12,
  roundSeconds: 35,
  allowPass: true,
  fastest: false,
  adminReads: false,
  categories: [],
  difficulties: []
};

const SCORE_LABELS = {
  all: 'Correcta +2 · fallo 0',
  normal: 'Correcta +3 · fallo −1',
  teams: 'Cada acierto +1 al jugador y al equipo',
  teams_majority: 'Mayoría +3 al equipo · si no, −1',
  teams_trust: 'Acierto +3 · fallo −1',
  know: 'Persona +2/−1 · predicciones +1/−1',
  challenge: 'Reto doble: acierto del retado +4 · fallo +4 para quien pasó'
};

const state = {
  user: null,
  gameId: Number(localStorage.getItem(GAME_ID_KEY) || GAME_ID_FALLBACK),
  room: null,
  isHost: false,
  hostId: '',
  players: [],
  settings: { ...DEFAULT_SETTINGS },
  categories: [],
  questionIndex: [],
  gameQuestionIds: [],
  currentRound: 0,
  currentQuestion: null,
  round: null,
  answers: {},
  predictions: {},
  scores: {},
  teamScores: { A: 0, B: 0 },
  reveal: null,
  status: 'idle',
  selectedAnswer: null,
  timerInterval: null,
  roundEndsAt: 0,
  socket: null,
  socketReady: false,
  socketRoomCode: null,
  socketReconnectAttempts: 0,
  socketReconnectTimer: null,
  socketManualClose: false,
  pollingTimer: null,
  pendingMessages: [],
  lastEventId: '',
  latestEvent: null,
  questionCache: new Map()
};

const $ = id => document.getElementById(id);
const sid = () => String(state.user?.id ?? '');
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value || 0)));
const isTeamMode = mode => Boolean(MODES[mode]?.team);
const currentMode = () => MODES[state.settings.mode] || MODES.all;
const escapeHTML = value => String(value ?? '').replace(/[&<'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const titleCase = value => String(value || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const difficultyLabel = value => ({ easy: 'Fácil', medium: 'Media', hard: 'Difícil' }[value] || titleCase(value || 'Nivel'));
const teamName = team => team === 'A' ? 'Equipo Morado' : 'Equipo Amarillo';
const teamEmoji = team => team === 'A' ? '🟣' : '🟡';
const playerById = id => state.players.find(player => String(player.id) === String(id));
const playersInTeam = team => state.players.filter(player => player.team === team);
const otherTeam = team => team === 'A' ? 'B' : 'A';

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
  $(`screen-${name}`)?.classList.add('active');
}

function toast(message, icon = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = `${icon ? `${icon} ` : ''}${message}`;
  el.classList.add('opacity-100');
  el.classList.remove('opacity-0');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.classList.add('opacity-0');
    el.classList.remove('opacity-100');
  }, 2800);
}

function setBusy(button, busy, text = '') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.dataset.originalText || button.textContent;
    button.textContent = text || 'Cargando…';
    button.disabled = true;
    button.classList.add('opacity-60');
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.classList.remove('opacity-60');
  }
}

async function fetchData(path) {
  let lastError = null;
  for (const base of DATA_BASES) {
    try {
      const url = `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
      const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const text = await response.text();
      return text.trim() ? JSON.parse(text) : null;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`No se pudo cargar ${path}`);
}

async function loadCatalog() {
  const status = $('catalog-status');
  if (status) status.textContent = 'Cargando preguntas de Trivial DB…';
  try {
    const [indexRaw, categoriesRaw] = await Promise.all([
      fetchData('index.json'),
      fetchData('categories.json').catch(() => null)
    ]);
    state.questionIndex = (Array.isArray(indexRaw) ? indexRaw : [])
      .map(item => ({ id: String(item.id || '').trim(), question: String(item.question || '').trim() }))
      .filter(item => item.id && item.question);
    const categories = Array.isArray(categoriesRaw?.categories) ? categoriesRaw.categories : [];
    state.categories = categories.map(category => ({
      id: String(category.id || '').trim(),
      name: String(category.name || titleCase(category.id)).trim(),
      questions: Array.isArray(category.questions) ? category.questions.map(String) : [],
      stats: category.stats || {},
      icon: category.icon || '❔',
      color: category.color || '#7C3AED'
    })).filter(category => category.id);
    renderCategoryList();
    if (status) {
      status.textContent = `${state.questionIndex.length.toLocaleString('es-ES')} preguntas cargadas · ${state.categories.length.toLocaleString('es-ES')} categorías`;
    }
  } catch (error) {
    console.error(error);
    state.questionIndex = [];
    state.categories = [];
    if (status) status.textContent = 'No se pudo cargar Trivial DB. Revisa GitHub Pages o raw.githubusercontent.com.';
  }
}

async function loadQuestion(id) {
  if (!id) return null;
  if (state.questionCache.has(id)) return state.questionCache.get(id);
  const raw = await fetchData(`questions/${id}.json`);
  const question = normalizeQuestion(raw);
  state.questionCache.set(id, question);
  return question;
}

function normalizeQuestion(raw = {}) {
  const answers = Array.isArray(raw.answers) ? raw.answers.map((answer, index) => ({
    id: String(index),
    text: String(answer.text ?? answer.answer ?? '').trim(),
    correct: Boolean(answer.correct)
  })).filter(answer => answer.text) : [];
  return {
    id: String(raw.id || '').trim(),
    status: raw.status || 'published',
    language: raw.language || 'es',
    category: String(raw.category || 'general'),
    subcategories: Array.isArray(raw.subcategories) ? raw.subcategories : [],
    difficulty: raw.difficulty || 'medium',
    question: String(raw.question || '').trim(),
    answers,
    explanation: String(raw.explanation || '').trim(),
    tags: Array.isArray(raw.tags) ? raw.tags : []
  };
}

function normalizePlayer(player = {}) {
  const username = String(player.username ?? player.name ?? player.display_name ?? player.user_name ?? '?').trim() || '?';
  const id = String(player.id ?? player.user_id ?? player.userId ?? player.uuid ?? username);
  const team = player.team === 'B' ? 'B' : 'A';
  return { id, username, team };
}

function currentPlayer() {
  return state.user ? normalizePlayer({ id: sid(), username: state.user.username, team: state.players.find(p => p.id === sid())?.team || 'A' }) : null;
}

function upsertPlayer(player) {
  if (!player) return null;
  const normalized = normalizePlayer(player);
  const index = state.players.findIndex(item => item.id === normalized.id);
  if (index >= 0) state.players[index] = { ...state.players[index], ...normalized };
  else state.players.push(normalized);
  if (!(normalized.id in state.scores)) state.scores[normalized.id] = 0;
  return normalized;
}

function assignTeams(players = state.players) {
  return players.map((player, index) => ({ ...normalizePlayer(player), team: index % 2 === 0 ? 'A' : 'B' }));
}

function normalizeRoom(raw = {}, fallbackCode = '') {
  const room = raw.room ?? raw.data?.room ?? raw;
  const code = String(room.code ?? room.room_code ?? room.roomCode ?? raw.room_code ?? fallbackCode ?? '').toUpperCase();
  return { ...room, code, id: room.id ?? room.room_id ?? raw.room_id ?? null };
}

function extractGameState(roomData = {}) {
  const room = roomData.room ?? roomData;
  const raw = room.game_state ?? room.gameState ?? room.state ?? {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return raw || {};
}

function roomHostId(roomData = {}, fallback = '') {
  const room = roomData.room ?? roomData;
  return String(room.host_id ?? room.hostId ?? room.host?.id ?? fallback ?? '');
}

function normalizeSettings(settings = {}) {
  const mode = MODES[settings.mode] ? settings.mode : DEFAULT_SETTINGS.mode;
  const categories = Array.isArray(settings.categories) ? settings.categories.map(String) : [];
  const difficulties = Array.isArray(settings.difficulties) ? settings.difficulties.filter(item => ['easy', 'medium', 'hard'].includes(item)) : [];
  return {
    mode,
    rounds: clamp(settings.rounds ?? settings.questions ?? DEFAULT_SETTINGS.rounds, 3, 60),
    roundSeconds: clamp(settings.roundSeconds ?? settings.time ?? DEFAULT_SETTINGS.roundSeconds, 10, 180),
    allowPass: settings.allowPass ?? settings.noLoSe ?? DEFAULT_SETTINGS.allowPass,
    fastest: Boolean(settings.fastest ?? DEFAULT_SETTINGS.fastest),
    adminReads: Boolean(settings.adminReads ?? DEFAULT_SETTINGS.adminReads),
    categories,
    difficulties
  };
}

function serializeGame(extra = {}) {
  return {
    status: extra.status ?? state.status,
    hostId: state.hostId,
    players: state.players,
    settings: state.settings,
    gameQuestionIds: state.gameQuestionIds,
    currentRound: state.currentRound,
    currentQuestion: state.currentQuestion,
    round: state.round,
    answers: state.answers,
    predictions: state.predictions,
    scores: state.scores,
    teamScores: state.teamScores,
    reveal: state.reveal,
    roundEndsAt: state.roundEndsAt,
    latestEvent: extra.latestEvent ?? state.latestEvent ?? null,
    savedAt: Date.now()
  };
}

function applyGameState(gameState = {}) {
  if (!gameState || typeof gameState !== 'object') return;
  state.status = gameState.status ?? state.status;
  state.hostId = String(gameState.hostId ?? state.hostId ?? '');
  state.isHost = state.hostId ? sid() === state.hostId : state.isHost;
  state.players = (gameState.players ?? state.players ?? []).map(normalizePlayer);
  state.settings = normalizeSettings(gameState.settings ?? state.settings);
  state.gameQuestionIds = Array.isArray(gameState.gameQuestionIds) ? gameState.gameQuestionIds.map(String) : state.gameQuestionIds;
  state.currentRound = Number(gameState.currentRound ?? state.currentRound ?? 0);
  state.currentQuestion = gameState.currentQuestion ? normalizeQuestion(gameState.currentQuestion) : state.currentQuestion;
  state.round = gameState.round ?? state.round ?? null;
  state.answers = gameState.answers ?? state.answers ?? {};
  state.predictions = gameState.predictions ?? state.predictions ?? {};
  state.scores = gameState.scores ?? state.scores ?? {};
  state.teamScores = { A: Number(gameState.teamScores?.A ?? state.teamScores?.A ?? 0), B: Number(gameState.teamScores?.B ?? state.teamScores?.B ?? 0) };
  state.reveal = gameState.reveal ?? state.reveal ?? null;
  state.roundEndsAt = Number(gameState.roundEndsAt ?? state.roundEndsAt ?? 0);
  state.latestEvent = gameState.latestEvent ?? state.latestEvent ?? null;
  if (state.user) upsertPlayer(currentPlayer());
}

function renderModes() {
  const root = $('mode-list');
  if (!root) return;
  root.innerHTML = Object.entries(MODES).map(([id, mode]) => `<button type="button" class="mode-card rounded-2xl p-3 text-left ${state.settings.mode === id ? 'active' : ''}" onclick="App.selectMode('${id}')">
    <span class="text-2xl">${mode.icon}</span>
    <span class="block font-black text-sm mt-1">${escapeHTML(mode.label)}</span>
    <span class="block text-[11px] text-violet-100/50 mt-1 leading-snug">${escapeHTML(mode.description)}</span>
  </button>`).join('');
}

function selectedCategoryInputs() {
  return [...document.querySelectorAll('#category-list input:checked')];
}

function selectedDifficultyInputs() {
  return [...document.querySelectorAll('.difficulty-filter:checked')];
}

function updateCategorySummary() {
  const selected = selectedCategoryInputs().map(input => input.value);
  const text = selected.length ? `${selected.length} elegida${selected.length === 1 ? '' : 's'}` : 'Todas';
  $('category-count') && ($('category-count').textContent = text);
}

function syncSettingsFromUI() {
  const selected = selectedCategoryInputs().map(input => input.value);
  const difficulties = selectedDifficultyInputs().map(input => input.value);
  state.settings = normalizeSettings({
    ...state.settings,
    rounds: $('cfg-rounds')?.value,
    roundSeconds: $('cfg-time')?.value,
    allowPass: $('cfg-pass')?.checked,
    fastest: $('cfg-fastest')?.checked,
    adminReads: $('cfg-admin-reads')?.checked,
    categories: selected,
    difficulties
  });
  updateCategorySummary();
  renderModes();
  return state.settings;
}

function applySettingsToUI(settings = state.settings) {
  const normalized = normalizeSettings(settings);
  if ($('cfg-rounds')) $('cfg-rounds').value = normalized.rounds;
  if ($('cfg-time')) $('cfg-time').value = normalized.roundSeconds;
  if ($('cfg-pass')) $('cfg-pass').checked = Boolean(normalized.allowPass);
  if ($('cfg-fastest')) $('cfg-fastest').checked = Boolean(normalized.fastest);
  if ($('cfg-admin-reads')) $('cfg-admin-reads').checked = Boolean(normalized.adminReads);
  document.querySelectorAll('#category-list input').forEach(input => { input.checked = normalized.categories.includes(input.value); });
  document.querySelectorAll('.difficulty-filter').forEach(input => { input.checked = normalized.difficulties.includes(input.value); });
  updateCategorySummary();
  renderModes();
}

function renderCategoryList() {
  const root = $('category-list');
  if (!root) return;
  root.innerHTML = state.categories.map(category => {
    const total = Number(category.stats?.total || category.questions?.length || 0);
    return `<label class="category-pill cursor-pointer rounded-2xl border border-white/10 px-3 py-2.5 text-xs font-bold text-violet-100/75 transition" data-category-name="${escapeHTML(`${category.name} ${category.id}`).toLowerCase()}">
      <input type="checkbox" class="sr-only" value="${escapeHTML(category.id)}" />
      <span class="category-check w-5 h-5 rounded-full bg-white/10 flex items-center justify-center text-[11px] font-black flex-shrink-0">✓</span>
      <span class="text-lg flex-shrink-0">${escapeHTML(category.icon || '❔')}</span>
      <span class="min-w-0 flex-1 truncate">${escapeHTML(category.name)}</span>
      <span class="opacity-45 text-[11px]">${total || ''}</span>
    </label>`;
  }).join('');
  updateCategorySummary();
}

function playerAvatar(player) {
  const colors = ['from-violet-400 to-purple-800', 'from-yellow-300 to-orange-600', 'from-cyan-300 to-blue-700', 'from-fuchsia-400 to-pink-700', 'from-rose-400 to-red-700', 'from-lime-300 to-emerald-700'];
  const hash = String(player.username || '?').split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const letter = escapeHTML(String(player.username || '?').trim()[0]?.toUpperCase() || '?');
  return `<span class="w-10 h-10 rounded-2xl bg-gradient-to-br ${colors[hash % colors.length]} flex items-center justify-center font-black shadow-lg shadow-black/20 flex-shrink-0">${letter}</span>`;
}

function renderWaiting() {
  showScreen('waiting');
  $('waiting-code') && ($('waiting-code').textContent = state.room?.code || '—');
  $('waiting-count') && ($('waiting-count').textContent = String(state.players.length));
  $('admin-settings')?.classList.toggle('hidden', !state.isHost);
  $('start-button')?.classList.toggle('hidden', !state.isHost);
  $('guest-wait')?.classList.toggle('hidden', state.isHost);
  applySettingsToUI(state.settings);
  const teamMode = isTeamMode(state.settings.mode);
  $('team-help') && ($('team-help').textContent = teamMode ? 'Equipos auto' : 'Individual');
  const root = $('waiting-players');
  if (root) {
    root.innerHTML = state.players.map(player => `<div class="panel rounded-2xl p-3 flex items-center gap-3">
      ${playerAvatar(player)}
      <div class="min-w-0 flex-1">
        <p class="font-black truncate">${escapeHTML(player.username)} ${player.id === sid() ? '<span class="text-xs text-brand-light">Tú</span>' : ''}</p>
        <p class="text-xs text-violet-100/45">${teamMode ? `${teamEmoji(player.team)} ${teamName(player.team)}` : (player.id === state.hostId ? 'Anfitrión' : 'Jugador')}</p>
      </div>
      ${player.id === state.hostId ? '<span class="text-xs font-black px-2 py-1 rounded-full bg-brand/25 text-brand-light">HOST</span>' : ''}
    </div>`).join('') || '<p class="text-violet-100/45 text-sm">Aún no hay jugadores.</p>';
  }
}

function currentQuestionMeta() {
  const q = state.currentQuestion || {};
  const category = state.categories.find(cat => cat.id === q.category);
  return { categoryName: category?.name || titleCase(q.category || 'General'), categoryIcon: category?.icon || '❔' };
}

function activeResponderIds() {
  if (!state.round) return [];
  if (state.round.challenge) return [String(state.round.challenge.challengeeId)];
  if (state.settings.fastest && state.round.buzzerOpen && !state.round.buzzerWinnerId && state.settings.mode !== 'know') return [];
  if (state.settings.fastest && state.round.buzzerWinnerId && state.settings.mode !== 'know') return [String(state.round.buzzerWinnerId)];
  return (state.round.activeResponderIds || []).map(String);
}

function buzzerCandidateIds() {
  if (!state.round || state.settings.mode === 'know' || !state.settings.fastest || !state.round.buzzerOpen || state.round.buzzerWinnerId) return [];
  return (state.round.buzzerCandidateIds || state.round.activeResponderIds || []).map(String);
}

function requiredAnswerIds() {
  return activeResponderIds();
}

function requiredPredictionIds() {
  return state.settings.mode === 'know' && !state.round?.challenge ? (state.round?.predictorIds || []).map(String) : [];
}

function hasMyAnswer() {
  return Boolean(state.answers?.[sid()]);
}

function hasMyPrediction() {
  return Boolean(state.predictions?.[sid()]);
}

function allRequiredDone() {
  const answerIds = requiredAnswerIds();
  const predictionIds = requiredPredictionIds();
  if (!answerIds.length && buzzerCandidateIds().length) return false;
  const answersDone = answerIds.every(id => state.answers?.[id]);
  const predictionsDone = predictionIds.every(id => state.predictions?.[id]);
  return answersDone && predictionsDone;
}

function renderGame() {
  showScreen('game');
  clearInterval(state.timerInterval);
  $('game-round') && ($('game-round').textContent = String(state.currentRound + 1));
  $('game-total') && ($('game-total').textContent = String(state.gameQuestionIds.length || state.settings.rounds));
  $('game-mode-label') && ($('game-mode-label').textContent = currentMode().label);
  const question = state.currentQuestion;
  if (!question) return;
  const meta = currentQuestionMeta();
  $('question-category') && ($('question-category').textContent = `${meta.categoryIcon} ${meta.categoryName}`);
  $('question-difficulty') && ($('question-difficulty').textContent = difficultyLabel(question.difficulty));
  const hideQuestion = state.settings.adminReads && !state.isHost;
  $('admin-read-badge')?.classList.toggle('hidden', !state.settings.adminReads);
  $('question-text') && ($('question-text').textContent = hideQuestion ? 'Pregunta leída por el anfitrión' : question.question);
  $('question-note') && ($('question-note').textContent = getQuestionNote());
  $('target-title') && ($('target-title').textContent = getTargetTitle());
  renderBuzzer();
  renderAnswers();
  renderPredictions();
  renderPassButton();
  renderPlayerStatus();
  renderScoreStrip();
  tickTimer();
  state.timerInterval = setInterval(tickTimer, 250);
}

function getTargetTitle() {
  const round = state.round || {};
  if (round.challenge) {
    return `${playerById(round.challenge.challengerId)?.username || 'Alguien'} pasa la pregunta a ${playerById(round.challenge.challengeeId)?.username || 'otro jugador'}`;
  }
  if (state.settings.fastest && round.buzzerWinnerId && state.settings.mode !== 'know') {
    return `Ha pulsado primero: ${playerById(round.buzzerWinnerId)?.username || '—'}`;
  }
  if (state.settings.fastest && round.buzzerOpen && state.settings.mode !== 'know') {
    return 'Pulsador abierto';
  }
  if (state.settings.mode === 'all') return 'Pregunta para todos';
  if (state.settings.mode === 'normal') return `Pregunta para ${playerById(round.targetPlayerId)?.username || '—'}`;
  if (state.settings.mode === 'know') return `¿${playerById(round.targetPlayerId)?.username || '—'} se la sabe?`;
  if (isTeamMode(state.settings.mode)) return `${teamEmoji(round.targetTeam)} ${teamName(round.targetTeam)}`;
  return 'Pregunta';
}

function getQuestionNote() {
  if (state.round?.challenge) return `Reto doble: si ${playerById(state.round.challenge.challengeeId)?.username || 'el retado'} falla, puntúa quien pasó; si acierta, puntúa el retado.`;
  if (state.settings.mode === 'know') return 'La persona elegida responde. Los demás apuestan si la sabe o no la sabe.';
  if (state.settings.fastest) return 'Primero hay que pulsar el botón. Solo quien pulse más rápido podrá responder.';
  return SCORE_LABELS[state.settings.mode] || '';
}

function renderBuzzer() {
  const candidateIds = buzzerCandidateIds();
  const canBuzz = candidateIds.includes(sid());
  const panel = $('buzzer-panel');
  if (!panel) return;
  panel.classList.toggle('hidden', !state.settings.fastest || state.settings.mode === 'know' || !state.round?.buzzerOpen || Boolean(state.round?.buzzerWinnerId) || Boolean(state.round?.challenge));
  $('buzzer-button') && ($('buzzer-button').disabled = !canBuzz);
  $('buzzer-button')?.classList.toggle('opacity-50', !canBuzz);
  $('buzzer-status') && ($('buzzer-status').textContent = canBuzz ? 'Te toca estar atento.' : 'No puedes pulsar en esta pregunta.');
}

function renderAnswers() {
  const root = $('answers-grid');
  if (!root) return;
  const question = state.currentQuestion;
  const responderIds = activeResponderIds();
  const myTurn = responderIds.includes(sid());
  const disabled = !myTurn || hasMyAnswer() || state.status !== 'playing';
  root.classList.toggle('hidden', state.settings.fastest && state.round?.buzzerOpen && !state.round?.buzzerWinnerId && !state.round?.challenge && state.settings.mode !== 'know');
  root.innerHTML = (question.answers || []).map((answer, index) => `<button type="button" class="btn-answer rounded-[1.5rem] p-5 text-left ${state.selectedAnswer === index ? 'selected' : ''}" ${disabled ? 'disabled' : ''} onclick="App.submitAnswer(${index})">
    <span class="text-xs font-black text-brand-light uppercase tracking-widest">${String.fromCharCode(65 + index)}</span>
    <span class="block text-lg sm:text-xl font-black mt-1">${escapeHTML(answer.text)}</span>
  </button>`).join('');
}

function renderPredictions() {
  const root = $('prediction-grid');
  if (!root) return;
  const predictorIds = requiredPredictionIds();
  const show = state.settings.mode === 'know' && predictorIds.includes(sid()) && !hasMyPrediction();
  root.classList.toggle('hidden', !show);
}

function renderPassButton() {
  const panel = $('pass-panel');
  if (!panel) return;
  const canPass = Boolean(state.settings.allowPass)
    && state.status === 'playing'
    && !state.round?.challenge
    && activeResponderIds().includes(sid())
    && !hasMyAnswer()
    && candidateChallengeIds(sid()).length > 0;
  panel.classList.toggle('hidden', !canPass);
}

function renderPlayerStatus() {
  const root = $('player-status');
  if (!root) return;
  const responderIds = activeResponderIds();
  const predictorIds = requiredPredictionIds();
  const buzzerIds = buzzerCandidateIds();
  if (buzzerIds.includes(sid())) root.textContent = 'Pulsa el botón si te la sabes.';
  else if (responderIds.includes(sid())) root.textContent = hasMyAnswer() ? 'Respuesta enviada. Esperando…' : 'Te toca responder.';
  else if (predictorIds.includes(sid())) root.textContent = hasMyPrediction() ? 'Predicción enviada. Esperando…' : 'Apuesta si la sabe o no la sabe.';
  else root.textContent = 'Espera al resto de jugadores.';
}

function renderScoreStrip() {
  const root = $('score-strip');
  if (!root) return;
  const teamMode = isTeamMode(state.settings.mode);
  const teamHtml = teamMode ? `<div class="grid grid-cols-2 gap-2 mb-1">
    <div class="panel rounded-2xl p-3 text-center"><p class="text-xs text-violet-100/45">${teamEmoji('A')} ${teamName('A')}</p><p class="text-3xl font-black text-gradient">${state.teamScores.A || 0}</p></div>
    <div class="panel rounded-2xl p-3 text-center"><p class="text-xs text-violet-100/45">${teamEmoji('B')} ${teamName('B')}</p><p class="text-3xl font-black text-gradient">${state.teamScores.B || 0}</p></div>
  </div>` : '';
  const ranking = [...state.players]
    .map(player => ({ ...player, score: Number(state.scores[player.id] || 0) }))
    .sort((a, b) => b.score - a.score);
  root.innerHTML = `${teamHtml}${ranking.map((player, index) => `<div class="panel rounded-2xl p-3 flex items-center gap-3">
    <span class="text-violet-100/40 font-black w-6">#${index + 1}</span>
    ${playerAvatar(player)}
    <div class="min-w-0 flex-1"><p class="font-black truncate">${escapeHTML(player.username)}</p><p class="text-xs text-violet-100/45">${teamMode ? `${teamEmoji(player.team)} ${teamName(player.team)}` : 'Jugador'}</p></div>
    <span class="text-2xl font-black text-gradient">${player.score}</span>
  </div>`).join('')}`;
}

function tickTimer() {
  const total = Number(state.settings.roundSeconds || DEFAULT_SETTINGS.roundSeconds);
  const remainingMs = Math.max(0, Number(state.roundEndsAt || 0) - Date.now());
  const remaining = Math.ceil(remainingMs / 1000);
  $('timer-label') && ($('timer-label').textContent = String(remaining));
  $('timer-bar') && ($('timer-bar').style.width = `${clamp((remainingMs / 1000) / total, 0, 1) * 100}%`);
  $('timer-label')?.classList.toggle('text-quiz-pink', remaining <= 8);
  $('timer-label')?.classList.toggle('pulse-timer', remaining <= 8);
  if (remaining <= 0 && state.status === 'playing') {
    clearInterval(state.timerInterval);
    if (state.isHost) App.revealRound();
    else $('player-status') && ($('player-status').textContent = 'Tiempo agotado. Esperando resultados…');
  }
}

function pickQuestionIds() {
  const selectedCategories = new Set(state.settings.categories || []);
  const selectedDifficulties = new Set(state.settings.difficulties || []);
  let ids = [];
  if (selectedCategories.size) {
    const categoryIds = state.categories
      .filter(category => selectedCategories.has(category.id))
      .flatMap(category => category.questions || []);
    ids = [...new Set(categoryIds.map(String))];
  } else {
    ids = state.questionIndex.map(item => item.id);
  }

  if (selectedDifficulties.size) {
    const knownById = new Map(state.questionIndex.map(item => [item.id, item]));
    ids = ids.filter(id => knownById.has(id));
  }

  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, state.settings.rounds);
}

async function nextValidQuestion(startIndex = state.currentRound) {
  const difficulties = new Set(state.settings.difficulties || []);
  for (let i = startIndex; i < state.gameQuestionIds.length; i++) {
    const id = state.gameQuestionIds[i];
    const question = await loadQuestion(id);
    if (!question?.answers?.length) continue;
    if (difficulties.size && !difficulties.has(question.difficulty)) continue;
    return { index: i, question };
  }
  return null;
}

function buildRound(index) {
  const mode = state.settings.mode;
  const players = [...state.players];
  const round = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    mode,
    roundNumber: index + 1,
    targetPlayerId: null,
    targetTeam: null,
    activeResponderIds: [],
    predictorIds: [],
    buzzerOpen: Boolean(state.settings.fastest && mode !== 'know'),
    buzzerCandidateIds: [],
    buzzerWinnerId: null,
    challenge: null
  };

  if (mode === 'all') {
    round.activeResponderIds = players.map(player => player.id);
  } else if (mode === 'normal') {
    const target = players[index % players.length];
    round.targetPlayerId = target?.id || null;
    round.activeResponderIds = target ? [target.id] : [];
  } else if (mode === 'know') {
    const target = players[index % players.length];
    round.targetPlayerId = target?.id || null;
    round.activeResponderIds = target ? [target.id] : [];
    round.predictorIds = players.filter(player => player.id !== target?.id).map(player => player.id);
  } else if (isTeamMode(mode)) {
    round.targetTeam = index % 2 === 0 ? 'A' : 'B';
    const teamPlayers = playersInTeam(round.targetTeam);
    if (mode === 'teams' || mode === 'teams_majority') {
      round.activeResponderIds = teamPlayers.map(player => player.id);
    } else {
      const target = teamPlayers[Math.floor(index / 2) % Math.max(1, teamPlayers.length)];
      round.targetPlayerId = target?.id || null;
      round.activeResponderIds = target ? [target.id] : [];
    }
  }

  round.buzzerCandidateIds = [...round.activeResponderIds];
  return round;
}

function candidateChallengeIds(challengerId) {
  const challenger = playerById(challengerId);
  if (!challenger) return [];
  if (isTeamMode(state.settings.mode)) {
    return state.players.filter(player => player.team !== challenger.team).map(player => player.id);
  }
  if (state.settings.mode === 'know') {
    return state.players.filter(player => player.id !== challengerId).map(player => player.id);
  }
  return state.players.filter(player => player.id !== challengerId).map(player => player.id);
}

function chooseChallengee(challengerId) {
  const ids = candidateChallengeIds(challengerId).filter(id => !state.answers[id]);
  if (!ids.length) return null;
  return ids[Math.floor(Math.random() * ids.length)];
}

function addScore(scores, playerId, delta) {
  const id = String(playerId);
  scores[id] = Number(scores[id] || 0) + Number(delta || 0);
}

function addTeamScore(teamScores, playerIdOrTeam, delta) {
  const team = ['A', 'B'].includes(playerIdOrTeam) ? playerIdOrTeam : playerById(playerIdOrTeam)?.team;
  if (!team) return;
  teamScores[team] = Number(teamScores[team] || 0) + Number(delta || 0);
}

function calculateReveal() {
  const question = state.currentQuestion;
  const correctIndex = question.answers.findIndex(answer => answer.correct);
  const correctText = question.answers[correctIndex]?.text || '—';
  const rows = state.players.map(player => {
    const answer = state.answers[player.id];
    const prediction = state.predictions[player.id];
    const answeredIndex = answer?.answerIndex;
    const correct = Number(answeredIndex) === correctIndex;
    const predictedCorrectly = prediction ? Boolean(prediction.thinksKnows) === Boolean(state.answers[state.round?.targetPlayerId]?.answerIndex === correctIndex) : null;
    return { player, answer, prediction, answeredIndex, correct, predictedCorrectly, points: 0, note: '' };
  });
  const nextScores = { ...state.scores };
  const nextTeamScores = { ...state.teamScores };
  let winners = [];
  let teamOutcome = '';

  if (state.round?.challenge) {
    const { challengerId, challengeeId } = state.round.challenge;
    const challengeAnswer = state.answers[challengeeId];
    const challengeCorrect = Number(challengeAnswer?.answerIndex) === correctIndex;
    if (challengeCorrect) {
      addScore(nextScores, challengeeId, 4);
      addTeamScore(nextTeamScores, challengeeId, 4);
      winners = [challengeeId];
      teamOutcome = `${playerById(challengeeId)?.username || 'El retado'} acierta el reto doble.`;
      rows.forEach(row => {
        if (row.player.id === challengeeId) { row.points = 4; row.note = 'Reto acertado'; }
      });
    } else {
      addScore(nextScores, challengerId, 4);
      addScore(nextScores, challengeeId, -1);
      addTeamScore(nextTeamScores, challengerId, 4);
      addTeamScore(nextTeamScores, challengeeId, -1);
      winners = [challengerId];
      teamOutcome = `${playerById(challengerId)?.username || 'Quien pasó'} gana el reto doble.`;
      rows.forEach(row => {
        if (row.player.id === challengerId) { row.points = 4; row.note = 'Gana por fallo del retado'; }
        if (row.player.id === challengeeId) { row.points = -1; row.note = 'Reto fallado'; }
      });
    }
  } else if (state.settings.mode === 'all') {
    rows.forEach(row => {
      if (row.answer) {
        row.points = row.correct ? 2 : 0;
        row.note = row.correct ? 'Acierto' : 'Fallo';
        addScore(nextScores, row.player.id, row.points);
        if (row.correct) winners.push(row.player.id);
      } else {
        row.note = 'Sin respuesta';
      }
    });
  } else if (state.settings.mode === 'normal' || (state.settings.fastest && state.round?.buzzerWinnerId)) {
    const targetId = state.settings.fastest && state.round?.buzzerWinnerId ? state.round.buzzerWinnerId : state.round.targetPlayerId;
    const row = rows.find(item => item.player.id === targetId);
    const points = row?.correct ? 3 : -1;
    if (row) {
      row.points = row.answer ? points : 0;
      row.note = row.answer ? (row.correct ? 'Acierto' : 'Fallo') : 'Sin respuesta';
      addScore(nextScores, targetId, row.points);
      if (row.correct) winners.push(targetId);
    }
  } else if (state.settings.mode === 'teams') {
    rows.forEach(row => {
      const isTargetTeam = row.player.team === state.round.targetTeam;
      if (!isTargetTeam) return;
      if (row.answer && row.correct) {
        row.points = 1;
        row.note = 'Acierto de equipo';
        addScore(nextScores, row.player.id, 1);
        addTeamScore(nextTeamScores, row.player.team, 1);
        winners.push(row.player.id);
      } else {
        row.note = row.answer ? 'Fallo de equipo' : 'Sin respuesta';
      }
    });
    teamOutcome = `${teamEmoji(state.round.targetTeam)} ${teamName(state.round.targetTeam)} suma por cada acierto.`;
  } else if (state.settings.mode === 'teams_majority') {
    const targetRows = rows.filter(row => row.player.team === state.round.targetTeam);
    const answered = targetRows.filter(row => row.answer);
    const correctCount = targetRows.filter(row => row.answer && row.correct).length;
    const needed = Math.floor(targetRows.length / 2) + 1;
    const majority = correctCount >= needed;
    addTeamScore(nextTeamScores, state.round.targetTeam, majority ? 3 : -1);
    teamOutcome = majority ? `${teamName(state.round.targetTeam)} consigue mayoría (${correctCount}/${targetRows.length})` : `${teamName(state.round.targetTeam)} no llega a mayoría (${correctCount}/${targetRows.length})`;
    targetRows.forEach(row => {
      if (row.answer && row.correct) {
        addScore(nextScores, row.player.id, 1);
        row.points = 1;
        row.note = majority ? 'Acierta y ayuda a la mayoría' : 'Acierta, pero no basta';
      } else {
        row.note = row.answer ? 'Fallo' : 'Sin respuesta';
      }
    });
    if (majority) winners = targetRows.map(row => row.player.id);
    if (!answered.length) teamOutcome = `${teamName(state.round.targetTeam)} no respondió.`;
  } else if (state.settings.mode === 'teams_trust') {
    const row = rows.find(item => item.player.id === state.round.targetPlayerId);
    const points = row?.answer ? (row.correct ? 3 : -1) : 0;
    if (row) {
      row.points = points;
      row.note = row.answer ? (row.correct ? 'El equipo confió bien' : 'Falló la confianza') : 'Sin respuesta';
      addScore(nextScores, row.player.id, points);
      addTeamScore(nextTeamScores, row.player.team, points);
      if (row.correct) winners.push(row.player.id);
      teamOutcome = `${teamName(row.player.team)} ${row.correct ? 'suma' : 'pierde'} por su elegido.`;
    }
  } else if (state.settings.mode === 'know') {
    const targetId = state.round.targetPlayerId;
    const targetRow = rows.find(row => row.player.id === targetId);
    const targetCorrect = Boolean(targetRow?.answer && targetRow.correct);
    if (targetRow) {
      targetRow.points = targetCorrect ? 2 : -1;
      targetRow.note = targetCorrect ? 'Se la sabía' : 'No se la sabía';
      addScore(nextScores, targetId, targetRow.points);
      if (targetCorrect) winners.push(targetId);
    }
    rows.forEach(row => {
      if (row.player.id === targetId) return;
      if (!row.prediction) {
        row.note = 'Sin predicción';
        return;
      }
      const predicted = Boolean(row.prediction.thinksKnows);
      const hit = predicted === targetCorrect;
      row.points = hit ? 1 : -1;
      row.note = hit ? 'Predicción acertada' : 'Predicción fallada';
      addScore(nextScores, row.player.id, row.points);
    });
  }

  rows.sort((a, b) => {
    if (a.points !== b.points) return b.points - a.points;
    if (a.answer && !b.answer) return -1;
    if (!a.answer && b.answer) return 1;
    return a.player.username.localeCompare(b.player.username, 'es');
  });

  return {
    question,
    correctIndex,
    correctText,
    rows,
    winners: [...new Set(winners)],
    scores: nextScores,
    teamScores: nextTeamScores,
    teamOutcome,
    rule: state.round?.challenge ? SCORE_LABELS.challenge : SCORE_LABELS[state.settings.mode]
  };
}

function renderReveal() {
  clearInterval(state.timerInterval);
  showScreen('reveal');
  const reveal = state.reveal;
  if (!reveal?.question) return;
  $('reveal-question') && ($('reveal-question').textContent = reveal.question.question);
  $('reveal-answer') && ($('reveal-answer').textContent = reveal.correctText);
  $('reveal-explanation') && ($('reveal-explanation').textContent = reveal.question.explanation || '');
  $('round-rule') && ($('round-rule').textContent = reveal.rule || currentMode().short);
  const winners = state.players.filter(player => reveal.winners?.includes(player.id));
  const winnerBox = $('round-winner-box');
  if (winnerBox) {
    winnerBox.innerHTML = `<p class="text-xs text-brand-light font-black uppercase tracking-widest">Ganador${winners.length > 1 ? 'es' : ''} de ronda</p>
      <div class="text-5xl my-2">${winners.length > 1 ? '🤝' : (winners.length ? '👑' : '😶')}</div>
      <p class="text-3xl font-black text-gradient">${winners.map(player => escapeHTML(player.username)).join(' + ') || 'Sin ganador'}</p>
      <p class="text-xs text-violet-100/55 mt-2">${escapeHTML(reveal.rule || '')}</p>`;
  }
  const teamBox = $('team-round-box');
  if (teamBox) {
    teamBox.innerHTML = isTeamMode(state.settings.mode) || state.round?.challenge ? `<div class="panel rounded-2xl p-4 text-center">
      <p class="text-sm text-violet-100/65">${escapeHTML(reveal.teamOutcome || 'Resultado de equipo')}</p>
      <div class="grid grid-cols-2 gap-2 mt-3">
        <div class="rounded-2xl bg-white/10 p-3"><p class="text-xs text-violet-100/45">${teamEmoji('A')} ${teamName('A')}</p><p class="text-3xl font-black text-gradient">${reveal.teamScores?.A || 0}</p></div>
        <div class="rounded-2xl bg-white/10 p-3"><p class="text-xs text-violet-100/45">${teamEmoji('B')} ${teamName('B')}</p><p class="text-3xl font-black text-gradient">${reveal.teamScores?.B || 0}</p></div>
      </div>
    </div>` : '';
  }
  const results = $('reveal-results');
  if (results) {
    results.innerHTML = reveal.rows.map((row, index) => {
      const answerText = row.answer ? reveal.question.answers[row.answer.answerIndex]?.text || '—' : 'Sin respuesta';
      const predictionText = row.prediction ? (row.prediction.thinksKnows ? 'Lo sabe' : 'No lo sabe') : '';
      const isWinner = reveal.winners?.includes(row.player.id);
      return `<div class="${isWinner ? 'winner-card bg-brand/20 border-brand-light/40' : 'panel'} rounded-2xl p-3 flex items-center gap-3 border ${isWinner ? '' : 'border-white/10'}" style="animation-delay:${index * 55}ms">
        ${playerAvatar(row.player)}
        <div class="min-w-0 flex-1">
          <p class="font-black truncate">${escapeHTML(row.player.username)} ${row.player.id === sid() ? '<span class="text-xs text-brand-light">Tú</span>' : ''}</p>
          <p class="text-xs text-violet-100/45">${row.prediction ? `Apuesta: ${escapeHTML(predictionText)}` : `Respuesta: ${escapeHTML(answerText)}`}</p>
          <p class="text-[11px] text-violet-100/40 mt-0.5">${escapeHTML(row.note || '')}</p>
        </div>
        <div class="text-right">
          <p class="font-black ${row.points > 0 ? 'text-quiz-green' : row.points < 0 ? 'text-quiz-pink' : 'text-violet-100/70'}">${row.points > 0 ? '+' : ''}${row.points}</p>
          <p class="text-xs text-violet-100/45">total ${Number(reveal.scores[row.player.id] || 0)}</p>
        </div>
      </div>`;
    }).join('');
  }
  $('next-round-button')?.classList.toggle('hidden', !state.isHost);
  $('guest-next-wait')?.classList.toggle('hidden', state.isHost);
}

function renderFinal() {
  clearInterval(state.timerInterval);
  showScreen('final');
  launchConfetti('final-confetti', 120);
  const ranking = state.players
    .map(player => ({ ...player, score: Number(state.scores[player.id] || 0) }))
    .sort((a, b) => b.score - a.score);
  const best = ranking[0]?.score ?? 0;
  const winners = ranking.filter(player => player.score === best);
  $('final-winner') && ($('final-winner').textContent = winners.map(player => player.username).join(' + ') || '—');
  const root = $('final-scores');
  if (root) {
    root.innerHTML = ranking.map((player, index) => `<div class="${index === 0 ? 'winner-card bg-brand/20 border-brand-light/40' : 'panel'} rounded-2xl p-3 flex items-center gap-3 border ${index === 0 ? '' : 'border-white/10'}">
      <span class="w-9 text-center font-black text-violet-100/55">#${index + 1}</span>
      ${playerAvatar(player)}
      <span class="flex-1 text-left font-black truncate">${escapeHTML(player.username)}</span>
      <span class="text-2xl font-black text-gradient">${player.score}</span>
    </div>`).join('');
  }
  const teamRoot = $('final-team-scores');
  if (teamRoot) {
    teamRoot.innerHTML = isTeamMode(state.settings.mode) ? `<div class="grid grid-cols-2 gap-2">
      <div class="panel rounded-2xl p-3 text-center"><p class="text-xs text-violet-100/45">${teamEmoji('A')} ${teamName('A')}</p><p class="text-3xl font-black text-gradient">${state.teamScores.A || 0}</p></div>
      <div class="panel rounded-2xl p-3 text-center"><p class="text-xs text-violet-100/45">${teamEmoji('B')} ${teamName('B')}</p><p class="text-3xl font-black text-gradient">${state.teamScores.B || 0}</p></div>
    </div>` : '';
  }
  $('new-game-button')?.classList.toggle('hidden', !state.isHost);
  $('guest-final-wait')?.classList.toggle('hidden', state.isHost);
}

function routeByStatus() {
  if (state.status === 'waiting') renderWaiting();
  else if (state.status === 'playing') renderGame();
  else if (state.status === 'reveal') renderReveal();
  else if (state.status === 'finished') renderFinal();
  else showScreen('login');
}

function launchConfetti(containerId = 'confetti-container', count = 90) {
  const colors = ['#7C3AED', '#C4B5FD', '#38BDF8', '#FB7185', '#FACC15', '#34D399'];
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.width = `${5 + Math.random() * 9}px`;
    piece.style.height = `${5 + Math.random() * 9}px`;
    piece.style.background = colors[i % colors.length];
    piece.style.borderRadius = Math.random() > .5 ? '50%' : '3px';
    piece.style.animationDuration = `${2.2 + Math.random() * 2.8}s`;
    piece.style.animationDelay = `${Math.random() * .8}s`;
    container.appendChild(piece);
  }
  setTimeout(() => { container.innerHTML = ''; }, 6200);
}

let socketConnectorPromise = null;
async function loadSocketConnector() {
  if (!socketConnectorPromise) {
    socketConnectorPromise = import('https://esm.sh/itty-sockets').then(mod => mod.connect).catch(error => {
      console.warn('No se pudo cargar itty-sockets. Se usará polling contra la API.', error);
      return null;
    });
  }
  return socketConnectorPromise;
}

function closeSocket(manual = true) {
  state.socketManualClose = manual;
  clearTimeout(state.socketReconnectTimer);
  clearInterval(state.pollingTimer);
  state.socketReconnectTimer = null;
  state.pollingTimer = null;
  state.socketReady = false;
  try { state.socket?.close?.(); } catch {}
  state.socket = null;
}

async function pollRoomState(roomCode) {
  try {
    const roomData = await api.getRoom(roomCode);
    const gameState = extractGameState(roomData);
    applyGameState(gameState);
    const latestEvent = gameState.latestEvent;
    if (latestEvent?.id && latestEvent.id !== state.lastEventId) handleEvent(latestEvent, { fromPoll: true });
    else routeByStatus();
  } catch (error) {
    console.warn('Error actualizando sala por polling', error);
  }
}

function setupPolling(roomCode) {
  $('realtime-badge') && ($('realtime-badge').textContent = 'API');
  $('realtime-badge')?.classList.remove('bg-brand/20', 'text-brand-light');
  clearInterval(state.pollingTimer);
  state.socketReady = true;
  state.pollingTimer = setInterval(() => pollRoomState(roomCode), POLL_MS);
  pollRoomState(roomCode);
  flushPendingMessages();
  return true;
}

async function connectRealtime(roomCode, { reconnect = false } = {}) {
  if (!roomCode) return false;
  if (!reconnect) {
    closeSocket(false);
    state.socketReconnectAttempts = 0;
  }
  state.socketRoomCode = roomCode;
  state.socketManualClose = false;
  const connect = await loadSocketConnector();
  if (!connect) return setupPolling(roomCode);
  try {
    state.socket = connect(`notelasabes-${roomCode}`);
    state.socketReady = true;
    state.socketReconnectAttempts = 0;
    $('realtime-badge') && ($('realtime-badge').textContent = 'LIVE');
    $('realtime-badge')?.classList.add('bg-brand/20', 'text-brand-light');
    state.socket.on?.('message', ({ message }) => {
      try { handleEvent(typeof message === 'string' ? JSON.parse(message) : message); }
      catch (error) { console.warn('socket parse error', error); }
    });
    const scheduleReconnect = () => {
      state.socketReady = false;
      if (state.socketManualClose || !state.socketRoomCode) return;
      if (state.socketReconnectAttempts >= SOCKET_MAX_RETRIES) {
        toast('Conexión por API activada', '📡');
        setupPolling(state.socketRoomCode);
        return;
      }
      state.socketReconnectAttempts += 1;
      clearTimeout(state.socketReconnectTimer);
      state.socketReconnectTimer = setTimeout(() => connectRealtime(state.socketRoomCode, { reconnect: true }), SOCKET_RECONNECT_MS * state.socketReconnectAttempts);
    };
    state.socket.on?.('close', scheduleReconnect);
    state.socket.on?.('error', scheduleReconnect);
    flushPendingMessages();
    return true;
  } catch (error) {
    console.warn('socket connect error', error);
    state.socketReady = false;
    return setupPolling(roomCode);
  }
}

function flushPendingMessages() {
  const queued = state.pendingMessages.splice(0);
  queued.forEach(event => emit(event.type, event));
}

function persistGameState(latestEvent = null) {
  if (!state.room?.code) return Promise.resolve();
  if (latestEvent) state.latestEvent = latestEvent;
  const gameState = serializeGame({ latestEvent: state.latestEvent, status: state.status });
  return api.updateRoomState(state.room.code, { gameState, status: state.status, roomSettings: state.settings }).catch(error => {
    console.warn('No se pudo persistir el estado', error);
  });
}

function emit(type, data = {}) {
  if (!state.room?.code) return;
  const event = { ...data, type, id: data.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`, senderId: sid() };
  state.latestEvent = event;
  const payload = { ...event, gameState: serializeGame({ latestEvent: event }) };
  if (state.socketReady && state.socket?.send && !state.pollingTimer) state.socket.send(JSON.stringify(payload));
  else if (!state.pollingTimer) state.pendingMessages.push(payload);
  persistGameState(event);
}

function handleEvent(event, { fromPoll = false } = {}) {
  if (!event?.type) return;
  if (event.id && event.id === state.lastEventId && fromPoll) return;
  if (event.id) state.lastEventId = event.id;
  if (event.gameState) applyGameState(event.gameState);
  switch (event.type) {
    case 'player_joined':
      upsertPlayer(event.player);
      if (state.isHost && !fromPoll) emit('room_update', { players: state.players });
      break;
    case 'room_update':
      state.players = (event.players ?? state.players).map(normalizePlayer);
      break;
    case 'settings_update':
      state.settings = normalizeSettings(event.settings ?? state.settings);
      applySettingsToUI(state.settings);
      break;
    case 'answer_submitted':
      if (event.playerId && event.answer) {
        state.answers = { ...state.answers, [String(event.playerId)]: event.answer };
        if (state.isHost && state.status === 'playing' && allRequiredDone()) setTimeout(() => App.revealRound(), 120);
      }
      break;
    case 'prediction_submitted':
      if (event.playerId && event.prediction) {
        state.predictions = { ...state.predictions, [String(event.playerId)]: event.prediction };
        if (state.isHost && state.status === 'playing' && allRequiredDone()) setTimeout(() => App.revealRound(), 120);
      }
      break;
    case 'buzzer_hit':
      if (!state.round?.buzzerWinnerId) {
        state.round = { ...state.round, buzzerWinnerId: event.playerId, buzzerOpen: false, activeResponderIds: [event.playerId] };
      }
      break;
    case 'question_passed':
      break;
    case 'round_revealed':
      launchConfetti('confetti-container', 70);
      break;
    case 'next_round':
    case 'game_started':
    case 'game_finished':
    case 'new_game':
      break;
  }
  saveActiveSession();
  routeByStatus();
}

async function mergeLatestRoomState() {
  if (!state.room?.code) return;
  try {
    const roomData = await api.getRoom(state.room.code);
    const gameState = extractGameState(roomData);
    applyGameState(gameState);
  } catch (error) {
    console.warn('No se pudo fusionar el estado de la sala', error);
  }
}

async function ensureGameId() {
  const saved = Number(localStorage.getItem(GAME_ID_KEY) || 0);
  if (saved > 0) {
    state.gameId = saved;
    return saved;
  }
  try {
    const result = await api.createGame(GAME_NAME, 32, DEFAULT_SETTINGS);
    const id = Number(result.game_id ?? result.id ?? result.game?.id ?? 0);
    if (id > 0) {
      state.gameId = id;
      localStorage.setItem(GAME_ID_KEY, String(id));
      return id;
    }
  } catch (error) {
    console.warn('No se pudo crear el juego. Se usará el ID de reserva.', error);
  }
  state.gameId = GAME_ID_FALLBACK;
  return state.gameId;
}

async function prepareUser() {
  const input = $('input-username');
  const error = $('login-error');
  const username = (input?.value || state.user?.username || '').trim();
  error?.classList.add('hidden');
  input?.classList.remove('shake');
  if (!username || username.length < 2) {
    if (error) {
      error.textContent = 'Pon un nombre de al menos 2 caracteres.';
      error.classList.remove('hidden');
    }
    input?.classList.add('shake');
    setTimeout(() => input?.classList.remove('shake'), 400);
    return false;
  }
  if (state.user?.id && state.user.username === username) return true;
  try {
    const result = await api.createUser(username, 'notelasabes', '');
    const user = { id: String(result.user_id ?? result.id ?? result.user?.id), username };
    state.user = user;
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    $('switch-user')?.classList.remove('hidden');
    return true;
  } catch (error) {
    const fallback = { id: `local-${Date.now()}`, username };
    state.user = fallback;
    localStorage.setItem(USER_KEY, JSON.stringify(fallback));
    toast('Jugador local creado. Revisa la API si no puedes crear sala.', '⚠️');
    return true;
  }
}

function restoreUser() {
  try {
    const saved = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    if (saved?.id && saved?.username) {
      saved.id = String(saved.id);
      state.user = saved;
      const input = $('input-username');
      if (input) input.value = saved.username;
      $('switch-user')?.classList.remove('hidden');
    }
  } catch {
    localStorage.removeItem(USER_KEY);
  }
}

function joinCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  return String(params.get('sala') || params.get('room') || '').toUpperCase();
}

function getShareUrl() {
  return `${location.origin}${location.pathname}?sala=${encodeURIComponent(state.room?.code || '')}`;
}

function renderQR(url) {
  const container = $('qr-container');
  if (!container) return;
  container.innerHTML = '';
  const img = document.createElement('img');
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(url)}`;
  img.width = 220;
  img.height = 220;
  img.alt = 'QR para unirse a la sala';
  img.className = 'rounded-2xl';
  container.appendChild(img);
}

function saveActiveSession() {
  if (!state.user || !state.room?.code) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: state.room.code, userId: sid(), isHost: state.isHost, hostId: state.hostId, savedAt: Date.now() }));
}

function clearActiveSession() {
  localStorage.removeItem(SESSION_KEY);
}

window.App = {
  async init() {
    restoreUser();
    renderModes();
    await loadCatalog();
    applySettingsToUI(state.settings);
    const pendingCode = joinCodeFromUrl();
    if (pendingCode) {
      $('join-container')?.classList.remove('hidden');
      $('login-actions')?.classList.add('hidden');
      const input = $('input-room-code');
      if (input) input.value = pendingCode;
      sessionStorage.setItem('pending_room', pendingCode);
    }
    document.querySelectorAll('#admin-settings input').forEach(input => {
      input.addEventListener('change', () => App.syncSettings());
      input.addEventListener('input', () => App.syncSettings());
    });
  },

  async createHomeRoom() {
    const button = $('btn-create-room');
    setBusy(button, true, 'Creando…');
    try {
      if (!(await prepareUser())) return;
      if (!state.questionIndex.length) {
        toast('Faltan preguntas de Trivial DB.', '⚠️');
        return;
      }
      await ensureGameId();
      syncSettingsFromUI();
      const player = currentPlayer();
      state.hostId = sid();
      state.isHost = true;
      state.players = [{ ...player, team: 'A' }];
      state.status = 'waiting';
      state.scores = { [sid()]: 0 };
      state.teamScores = { A: 0, B: 0 };
      state.answers = {};
      state.predictions = {};
      state.gameQuestionIds = [];
      state.currentRound = 0;
      state.currentQuestion = null;
      state.round = null;
      state.reveal = null;
      const initialState = serializeGame({ status: 'waiting' });
      const roomResult = await api.createRoom(state.gameId, sid(), state.settings, initialState);
      state.room = normalizeRoom(roomResult);
      saveActiveSession();
      await connectRealtime(state.room.code);
      emit('player_joined', { player: state.players[0] });
      renderWaiting();
      toast('Sala creada', '❓');
    } catch (error) {
      console.error(error);
      toast(error.message || 'No se pudo crear la sala.', '⚠️');
    } finally {
      setBusy(button, false);
    }
  },

  async showJoinForm(roomCode = '') {
    if (!(await prepareUser())) return;
    $('join-container')?.classList.remove('hidden');
    $('login-actions')?.classList.add('hidden');
    const input = $('input-room-code');
    if (input && roomCode) input.value = roomCode;
    input?.focus();
  },

  hideJoinForm() {
    $('join-container')?.classList.add('hidden');
    $('login-actions')?.classList.remove('hidden');
  },

  async joinHomeRoom() {
    const error = $('join-error');
    const code = String($('input-room-code')?.value || sessionStorage.getItem('pending_room') || '').trim().toUpperCase();
    error?.classList.add('hidden');
    if (!(await prepareUser())) return;
    if (!code || code.length < 4) {
      if (error) {
        error.textContent = 'Introduce un código de sala válido.';
        error.classList.remove('hidden');
      }
      return;
    }
    try {
      const roomData = await api.getRoom(code);
      state.room = normalizeRoom(roomData, code);
      state.hostId = roomHostId(roomData, state.hostId);
      applyGameState(extractGameState(roomData));
      state.isHost = sid() === state.hostId;
      const player = normalizePlayer({ ...currentPlayer(), team: state.players.length % 2 === 0 ? 'A' : 'B' });
      await api.joinRoom(code, sid()).catch(error => console.warn('joinRoom no completado, se continúa con estado del juego', error));
      upsertPlayer(player);
      saveActiveSession();
      await connectRealtime(code);
      emit('player_joined', { player });
      renderWaiting();
      toast('Dentro de la sala', '✅');
    } catch (error) {
      console.error(error);
      if (error) {
        if (error.message) toast(error.message, '⚠️');
        if (error && error.message && error.message.includes('404')) toast('Sala no encontrada.', '⚠️');
      }
      if (error && error.message && $('join-error')) {
        $('join-error').textContent = 'No se pudo entrar en la sala.';
        $('join-error').classList.remove('hidden');
      }
    }
  },

  async startGame() {
    if (!state.isHost) return;
    syncSettingsFromUI();
    if (state.players.length < 1) return;
    if (isTeamMode(state.settings.mode) && state.players.length < 2) {
      toast('Para jugar por equipos hacen falta al menos 2 jugadores.', '⚠️');
      return;
    }
    try {
      state.players = assignTeams(state.players);
      state.gameQuestionIds = pickQuestionIds();
      if (!state.gameQuestionIds.length) {
        toast('No hay preguntas para esos filtros.', '⚠️');
        return;
      }
      const next = await nextValidQuestion(0);
      if (!next) {
        toast('No se encontraron preguntas válidas para esos filtros.', '⚠️');
        return;
      }
      state.currentRound = next.index;
      state.currentQuestion = next.question;
      state.round = buildRound(state.currentRound);
      state.answers = {};
      state.predictions = {};
      state.scores = Object.fromEntries(state.players.map(player => [player.id, 0]));
      state.teamScores = { A: 0, B: 0 };
      state.reveal = null;
      state.status = 'playing';
      state.roundEndsAt = Date.now() + state.settings.roundSeconds * 1000;
      emit('game_started', { gameState: serializeGame({ status: 'playing' }) });
      routeByStatus();
    } catch (error) {
      console.error(error);
      toast('No se pudo iniciar la partida.', '⚠️');
    }
  },

  submitAnswer(answerIndex) {
    if (state.status !== 'playing') return;
    if (!activeResponderIds().includes(sid())) {
      toast('Ahora no te toca responder.', '👀');
      return;
    }
    if (hasMyAnswer()) return;
    const idx = Number(answerIndex);
    state.selectedAnswer = idx;
    const answer = { answerIndex: idx, at: Date.now(), questionId: state.currentQuestion?.id };
    state.answers = { ...state.answers, [sid()]: answer };
    emit('answer_submitted', { playerId: sid(), answer });
    renderGame();
    if (state.isHost && allRequiredDone()) setTimeout(() => App.revealRound(), 120);
  },

  submitPrediction(thinksKnows) {
    if (state.status !== 'playing' || state.settings.mode !== 'know') return;
    if (!requiredPredictionIds().includes(sid())) {
      toast('No puedes apostar en esta pregunta.', '👀');
      return;
    }
    if (hasMyPrediction()) return;
    const prediction = { thinksKnows: Boolean(thinksKnows), at: Date.now(), targetPlayerId: state.round?.targetPlayerId };
    state.predictions = { ...state.predictions, [sid()]: prediction };
    emit('prediction_submitted', { playerId: sid(), prediction });
    renderGame();
    if (state.isHost && allRequiredDone()) setTimeout(() => App.revealRound(), 120);
  },

  hitBuzzer() {
    if (state.status !== 'playing' || !state.settings.fastest || state.settings.mode === 'know') return;
    if (!buzzerCandidateIds().includes(sid())) return;
    if (state.round?.buzzerWinnerId) return;
    state.round = { ...state.round, buzzerWinnerId: sid(), buzzerOpen: false, activeResponderIds: [sid()] };
    emit('buzzer_hit', { playerId: sid(), hitAt: Date.now() });
    renderGame();
  },

  passQuestion() {
    if (!state.settings.allowPass || state.round?.challenge || !activeResponderIds().includes(sid())) return;
    const challengeeId = chooseChallengee(sid());
    if (!challengeeId) {
      toast('No hay nadie disponible para el reto.', '⚠️');
      return;
    }
    state.answers = {};
    state.predictions = {};
    state.round = {
      ...state.round,
      challenge: { challengerId: sid(), challengeeId, originalMode: state.settings.mode },
      activeResponderIds: [challengeeId],
      predictorIds: [],
      buzzerOpen: false,
      buzzerWinnerId: null
    };
    state.roundEndsAt = Date.now() + state.settings.roundSeconds * 1000;
    emit('question_passed', { challengerId: sid(), challengeeId, gameState: serializeGame({ status: 'playing' }) });
    toast(`Pregunta pasada a ${playerById(challengeeId)?.username || 'otro jugador'}`, '🎯');
    renderGame();
  },

  revealRound() {
    if (!state.isHost || state.status !== 'playing') return;
    state.reveal = calculateReveal();
    state.scores = state.reveal.scores;
    state.teamScores = state.reveal.teamScores;
    state.status = 'reveal';
    emit('round_revealed', { gameState: serializeGame({ status: 'reveal' }) });
    launchConfetti('confetti-container', 70);
    renderReveal();
  },

  async nextRound() {
    if (!state.isHost) return;
    try {
      const next = await nextValidQuestion(state.currentRound + 1);
      if (!next) {
        state.status = 'finished';
        emit('game_finished', { gameState: serializeGame({ status: 'finished' }) });
        renderFinal();
        return;
      }
      state.currentRound = next.index;
      state.currentQuestion = next.question;
      state.round = buildRound(state.currentRound);
      state.answers = {};
      state.predictions = {};
      state.reveal = null;
      state.selectedAnswer = null;
      state.status = 'playing';
      state.roundEndsAt = Date.now() + state.settings.roundSeconds * 1000;
      emit('next_round', { gameState: serializeGame({ status: 'playing' }) });
      renderGame();
    } catch (error) {
      console.error(error);
      toast('No se pudo cargar la siguiente pregunta.', '⚠️');
    }
  },

  async newGame() {
    if (!state.isHost) return;
    state.status = 'waiting';
    state.answers = {};
    state.predictions = {};
    state.reveal = null;
    state.round = null;
    state.currentQuestion = null;
    state.currentRound = 0;
    state.gameQuestionIds = [];
    state.scores = Object.fromEntries(state.players.map(player => [player.id, 0]));
    state.teamScores = { A: 0, B: 0 };
    emit('new_game', { gameState: serializeGame({ status: 'waiting' }) });
    renderWaiting();
  },

  selectMode(mode) {
    if (!MODES[mode] || !state.isHost && state.room) return;
    state.settings.mode = mode;
    syncSettingsFromUI();
    if (state.isHost && state.room?.code) emit('settings_update', { settings: state.settings });
  },

  adjustSetting(key, delta) {
    const map = { rounds: ['cfg-rounds', 3, 60], roundSeconds: ['cfg-time', 10, 180] };
    const [id, min, max] = map[key] || [];
    const input = $(id);
    if (!input) return;
    input.value = clamp(Number(input.value || 0) + delta, min, max);
    App.syncSettings();
  },

  syncSettings() {
    if (!state.isHost && state.room) return;
    syncSettingsFromUI();
    if (state.isHost && state.room?.code) emit('settings_update', { settings: state.settings });
  },

  clearCategories() {
    document.querySelectorAll('#category-list input').forEach(input => { input.checked = false; });
    App.syncSettings();
  },

  focusCategories() {
    $('category-search')?.focus();
  },

  filterCategories(value) {
    const q = String(value || '').trim().toLowerCase();
    document.querySelectorAll('#category-list [data-category-name]').forEach(item => {
      item.classList.toggle('hidden', q && !item.dataset.categoryName.includes(q));
    });
  },

  openShareModal() {
    if (!state.room?.code) return;
    const url = getShareUrl();
    $('share-code') && ($('share-code').textContent = state.room.code);
    $('share-link') && ($('share-link').value = url);
    renderQR(url);
    $('share-modal')?.classList.remove('hidden');
    $('share-modal')?.classList.add('flex');
  },

  closeShareModal() {
    $('share-modal')?.classList.add('hidden');
    $('share-modal')?.classList.remove('flex');
  },

  async copyShareLink() {
    const url = getShareUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast('Enlace copiado', '✅');
    } catch {
      $('share-link')?.select();
      document.execCommand('copy');
      toast('Enlace copiado', '✅');
    }
  },

  async nativeShare() {
    const url = getShareUrl();
    if (navigator.share) {
      try { await navigator.share({ title: 'No te la sabes', text: `Únete a mi sala ${state.room?.code}`, url }); }
      catch {}
    } else {
      App.copyShareLink();
    }
  },

  switchUser() {
    localStorage.removeItem(USER_KEY);
    clearActiveSession();
    state.user = null;
    $('input-username') && ($('input-username').value = '');
    $('switch-user')?.classList.add('hidden');
    showScreen('login');
  },

  exitToHome() {
    closeSocket(true);
    clearActiveSession();
    state.room = null;
    state.isHost = false;
    state.status = 'idle';
    showScreen('login');
  }
};

window.addEventListener('beforeunload', () => closeSocket(true));
window.addEventListener('DOMContentLoaded', () => App.init());
