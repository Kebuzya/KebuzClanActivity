'use strict';

// STATE
const state = {
  spreadsheetId:   null,
  clanName:        null,
  mode:            'today',   // 'today' | 'lab' | 'archive'
  players:         [],
  todayLogs:       {},        // {nick: {torg, labirint, pohod, labWrong, labComment}}
  todayDate:       null,
  editedLogs:      {},        // накапливает изменения до нажатия «Сохранить»
  filter:          '',        // поиск по нику
  archiveFromDate: null,      // строка дд.мм.гггг
  archiveToDate:   null,      // строка дд.мм.гггг
  archiveData:     [],        // данные одной даты (для режима редактирования)
  archiveGroups:   [],        // [{date, entries}] для диапазонного вида
  archiveEdits:    {},        // {nick: {torg, labirint, pohod, labWrong, labComment, warning, warnReason}}
  archiveEditMode: false,
  confirmCb:       null,      // коллбэк для модального подтверждения
  retroDate:       null,      // null = сегодня, 'дд.мм.гггг' = ретро-режим
  retroLogs:       {},        // {nick: {...}} для ретро-режима
  retroOrigLogs:   {},        // исходные значения из архива (неизменны в течение сессии)
  modalNick:       null,      // ник, открытый в модалке лабиринта или предупреждения
};

// API
async function api(action, params) {
  const url = localStorage.getItem('scriptUrl') || CONFIG.SCRIPT_URL;
  const payload = Object.assign({ action, spreadsheetId: state.spreadsheetId }, params || {});

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) throw new Error('HTTP ' + resp.status);

  const json = await resp.json();
  if (!json.success) throw new Error(json.error || 'Ошибка сервера');
  return json.data;
}

// createClan не передаёт spreadsheetId
async function apiCreateClan(clanName, ownerEmail) {
  const url = localStorage.getItem('scriptUrl') || CONFIG.SCRIPT_URL;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: JSON.stringify({ action: 'createClan', clanName, ownerEmail }),
  });

  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const json = await resp.json();
  if (!json.success) throw new Error(json.error || 'Ошибка сервера');
  return json.data;
}

// Утилиты
function showLoading() { el('loading').classList.remove('hidden'); }
function hideLoading() { el('loading').classList.add('hidden'); }

function showToast(message, type) {
  const toast = el('toast');
  toast.textContent = message;
  toast.className = 'toast toast-' + (type || 'info');
  toast.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(function() { toast.classList.add('hidden'); }, 3200);
}

function el(id) { return document.getElementById(id); }

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Конвертирует ISO yyyy-MM-dd → дд.мм.гггг
function isoToDisplay(isoDate) {
  if (!isoDate) return '';
  var parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return parts[2] + '.' + parts[1] + '.' + parts[0];
}

// Конвертирует дд.мм.гггг → yyyy-MM-dd (для date input)
function displayToIso(displayDate) {
  if (!displayDate) return '';
  var parts = displayDate.split('.');
  if (parts.length !== 3) return displayDate;
  return parts[2] + '-' + parts[1] + '-' + parts[0];
}

function localIso(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Возвращает массив дат (дд.мм.гггг) от toStr до fromStr включительно (новые первые)
function getDateRange(fromStr, toStr) {
  function parse(str) {
    var p = str.split('.');
    if (p.length !== 3) return null;
    return new Date(+p[2], +p[1] - 1, +p[0]);
  }
  var from = parse(fromStr);
  var to   = parse(toStr);
  if (!from || !to || from > to) return [];
  var dates = [];
  var cur = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cur >= from && dates.length <= 31) {
    dates.push(isoToDisplay(localIso(cur)));
    cur.setDate(cur.getDate() - 1);
  }
  return dates;
}

// Отметки дня
function emptyLog() {
  return { torg: false, labirint: '', pohod: false, labWrong: false, labComment: '' };
}

// Штрафные ключи как число: '' считается нулём
function keysNum(value) {
  if (value === '' || value === null || value === undefined) return 0;
  var num = Number(value);
  return isNaN(num) ? 0 : num;
}

// Текущее состояние отметок игрока с учётом несохранённых правок
function currentLog(nick) {
  if (state.retroDate) {
    return Object.assign(emptyLog(), state.retroLogs[nick]);
  }
  return Object.assign(emptyLog(), state.todayLogs[nick], state.editedLogs[nick]);
}

// Исходное состояние — база для предпросмотра счётчиков
function origLog(nick) {
  return state.retroDate
    ? Object.assign(emptyLog(), state.retroOrigLogs[nick])
    : Object.assign(emptyLog(), state.todayLogs[nick]);
}

// Единственная точка записи отметок: и таблица, и экран лабиринта, и модалки
function setLog(nick, patch) {
  if (state.retroDate) {
    state.retroLogs[nick] = Object.assign(emptyLog(), state.retroLogs[nick], patch);
  } else {
    state.editedLogs[nick] = Object.assign(emptyLog(), state.todayLogs[nick], state.editedLogs[nick], patch);
    scheduleAutoSave();
  }
}

// Автосохранение
var autoSaveTimer = null;

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(function() {
    if (!state.retroDate && Object.keys(state.editedLogs).length > 0) {
      saveLogs(true);
    }
  }, 3 * 60 * 1000);
}

function cancelAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
}

// Стартовая страница
function showStartPage() {
  el('start-page').classList.remove('hidden');
  el('app-page').classList.add('hidden');
}

function showAppPage() {
  el('start-page').classList.add('hidden');
  el('app-page').classList.remove('hidden');
}

async function connectToSpreadsheet(id) {
  if (!id || !id.trim()) {
    showToast('Введите ID таблицы', 'error');
    return;
  }
  state.spreadsheetId = id.trim();
  localStorage.setItem('spreadsheetId', state.spreadsheetId);
  await loadData();
}

async function createClan(name, email) {
  if (!name || !name.trim()) {
    showToast('Введите название клана', 'error');
    return;
  }
  showLoading();
  try {
    var result = await apiCreateClan(name.trim(), (email || '').trim());
    state.spreadsheetId = result.spreadsheetId;
    state.clanName = result.clanName;
    localStorage.setItem('spreadsheetId', result.spreadsheetId);
    localStorage.setItem('clanName', result.clanName);
    updateUrlParam(result.spreadsheetId);
    await loadData();
    showToast('Клан создан!', 'success');
  } catch (err) {
    showToast('Ошибка создания клана: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

function updateUrlParam(tableId) {
  var url = new URL(location.href);
  url.searchParams.set('table', tableId);
  history.replaceState({}, '', url.toString());
}

// Загрузка данных
async function loadData() {
  cancelAutoSave();
  showLoading();
  try {
    var results = await Promise.all([
      api('getPlayers'),
      api('getTodayLogs'),
    ]);

    var playersResult = results[0];
    var logsResult    = results[1];

    state.players    = playersResult.players || [];
    state.clanName   = playersResult.clanName || 'Клан';
    state.todayDate  = logsResult.date || '';
    state.todayLogs  = logsResult.logs || {};
    state.editedLogs = {};
    // Экран лабиринта — часть текущего дня, из него выкидывать не надо
    if (state.mode !== 'lab') state.mode = 'today';
    state.retroDate     = null;
    state.retroLogs     = {};
    state.retroOrigLogs = {};

    localStorage.setItem('clanName', state.clanName);
    updateUrlParam(state.spreadsheetId);

    showAppPage();
    renderApp();
    initRetroDatePicker();
  } catch (err) {
    showToast('Ошибка загрузки: ' + err.message, 'error');
    // Если таблица недоступна — вернуть на стартовую
    if (!state.clanName) showStartPage();
  } finally {
    hideLoading();
  }
}

// Рендер приложения
function renderApp() {
  el('clan-name-display').textContent = state.clanName || 'Клан';
  el('date-display').textContent      = state.retroDate || state.todayDate || '';

  var isArchive = state.mode === 'archive';
  var isLab     = state.mode === 'lab';

  el('today-controls').classList.toggle('hidden', isArchive || isLab);
  el('lab-controls').classList.toggle('hidden', !isLab);
  el('archive-controls').classList.toggle('hidden', !isArchive);
  el('table-toolbar').classList.toggle('hidden', isArchive);

  el('btn-archive').classList.toggle('hidden', isArchive);
  el('btn-lab').classList.toggle('hidden', isLab);
  el('btn-today').classList.toggle('hidden', !isArchive && !isLab);

  if (isArchive)   renderArchive();
  else if (isLab)  renderLab();
  else             renderPlayers();
}

// Ретро-режим — инициализация пикера дат
function initRetroDatePicker() {
  if (!state.todayDate) return;
  var parts = state.todayDate.split('.');
  if (parts.length !== 3) return;
  var todayD = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  var maxDate = new Date(todayD.getFullYear(), todayD.getMonth(), todayD.getDate() - 1);
  var picker = el('retro-date-picker');
  picker.max = localIso(maxDate);
  if (!state.retroDate) picker.value = '';
}

// Ретро-режим — вход
async function enterRetroMode(isoDate) {
  var displayDate = isoToDisplay(isoDate);
  showLoading();
  try {
    var entries = await api('getArchive', { date: displayDate });
    state.retroLogs     = {};
    state.retroOrigLogs = {};
    (entries || []).forEach(function(entry) {
      state.retroLogs[entry.nick]     = Object.assign(emptyLog(), entry);
      state.retroOrigLogs[entry.nick] = Object.assign(emptyLog(), entry);
    });
    state.retroDate = displayDate;
    el('btn-add-player').classList.add('hidden');
    el('btn-retro-today').classList.remove('hidden');
    el('btn-save').textContent = '💾 В архив';
    el('today-controls').classList.add('retro-mode');
    el('date-display').textContent = displayDate;
    el('date-display').classList.add('retro-badge');
    renderApp();
  } catch (err) {
    showToast('Ошибка загрузки: ' + err.message, 'error');
    el('retro-date-picker').value = '';
  } finally {
    hideLoading();
  }
}

// Ретро-режим — выход
function exitRetroMode() {
  state.retroDate     = null;
  state.retroLogs     = {};
  state.retroOrigLogs = {};
  el('retro-date-picker').value = '';
  el('btn-add-player').classList.remove('hidden');
  el('btn-retro-today').classList.add('hidden');
  el('btn-save').textContent = '💾 Сохранить';
  el('today-controls').classList.remove('retro-mode');
  el('date-display').textContent = state.todayDate || '';
  el('date-display').classList.remove('retro-badge');
  renderApp();
}

// Ретро-режим — сохранение в архив
async function saveRetroDay() {
  if (!state.retroDate) return;
  showLoading();
  try {
    var result = await api('saveRetroDay', { date: state.retroDate, logs: state.retroLogs });
    showToast('Сохранено за ' + state.retroDate + ' (' + (result.saved || 0) + ' записей)', 'success');
    // Обновляем список игроков, чтобы подтянуть новые значения счётчиков
    var results = await Promise.all([api('getPlayers'), api('getTodayLogs')]);
    state.players   = results[0].players  || [];
    state.clanName  = results[0].clanName || 'Клан';
    state.todayDate = results[1].date     || '';
    state.todayLogs = results[1].logs     || {};
    // Сохранённое становится новой точкой отсчёта для предпросмотра
    state.retroOrigLogs = {};
    Object.keys(state.retroLogs).forEach(function(nick) {
      state.retroOrigLogs[nick] = Object.assign(emptyLog(), state.retroLogs[nick]);
    });
    initRetroDatePicker();
    renderApp();
  } catch (err) {
    showToast('Ошибка сохранения: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

// Текущий день - рендер игроков
function sortPlayers(players) {
  return players.slice().sort(function(a, b) {
    var aD = a.role === 'Заместитель';
    var bD = b.role === 'Заместитель';
    if (aD !== bD) return aD ? -1 : 1;
    return a.nick.localeCompare(b.nick, 'ru');
  });
}

function visiblePlayers() {
  var list = sortPlayers(state.players);
  var filter = state.filter.trim().toLowerCase();
  if (!filter) return list;
  return list.filter(function(p) { return p.nick.toLowerCase().indexOf(filter) !== -1; });
}

function getRowBg(player) {
  if (player.isTemp)      return 'var(--row-temp)';
  if (player.onVacation)  return 'var(--row-vacation)';
  if (player.joinDate) {
    var joinDate = new Date(player.joinDate);
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);
    cutoff.setHours(0, 0, 0, 0);
    if (!isNaN(joinDate.getTime()) && joinDate >= cutoff) return 'var(--row-new)';
  }
  return '';
}

function getMissClass(count) {
  var n = +count || 0;
  if (n >= 3) return ' miss-3';
  if (n === 2) return ' miss-2';
  if (n === 1) return ' miss-1';
  return '';
}

// Предпросмотр счётчиков с учётом несохранённых изменений.
// Лабиринт суммируется (штрафные ключи), торг и поход считаются по дням.
function getPreviewSkip(player, field) {
  var skipField = field === 'torg' ? 'skipT' : field === 'labirint' ? 'skipL' : 'skipP';
  var count = +player[skipField] || 0;
  var orig  = origLog(player.nick);
  var cur   = currentLog(player.nick);

  if (field === 'labirint') {
    return Math.max(0, count + keysNum(cur.labirint) - keysNum(orig.labirint));
  }

  // torg/pohod: true = пропуск, false = присутствовал
  if (!orig[field] && cur[field]) count++;
  if (orig[field] && !cur[field]) count = Math.max(0, count - 1);
  return count;
}

// Возраст предупреждения в днях, -1 если предупреждения нет
function warnAgeDays(player) {
  if (!player.warnActive || !player.warnDate) return -1;
  var issued = new Date(player.warnDate + 'T00:00:00');
  if (isNaN(issued.getTime())) return -1;
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today - issued) / 86400000);
}

// Предупреждение за неделю: архивные + сегодняшнее, которое туда ещё не попало
function warnDisplayCount(player) {
  var count = +player.warnCount || 0;
  if (player.warnActive && player.warnDate && isoToDisplay(player.warnDate) === state.todayDate) count++;
  return count;
}

function warnFlagHtml(player) {
  var age = warnAgeDays(player);
  if (age < 0) return '';
  var cls   = age >= CONFIG.WARN_FADE_DAY ? 'warn-flag warn-stale' : 'warn-flag warn-fresh';
  var left  = CONFIG.WARN_DAYS - age;
  var title = 'Предупреждение от ' + isoToDisplay(player.warnDate) +
              (player.warnReason ? ': ' + player.warnReason : '') +
              ' (осталось дней: ' + left + ')';
  var count = warnDisplayCount(player);
  var badge = count > 1 ? '<sup>' + count + '</sup>' : '';
  return '<span class="' + cls + '" title="' + esc(title) + '">🚩' + badge + '</span>';
}

var LAB_LABEL_EMPTY = '—';

function labOptions() {
  var opts = [''];
  for (var i = 0; i <= CONFIG.LAB_MAX_KEYS; i++) opts.push(String(i));
  return opts;
}

function buildLabSelect(currentVal, disabled) {
  var html = '<select class="lab-select"' + (disabled ? ' disabled' : '') + '>';
  labOptions().forEach(function(v) {
    var sel = currentVal === v ? ' selected' : '';
    html += '<option value="' + esc(v) + '"' + sel + '>' + esc(v === '' ? LAB_LABEL_EMPTY : v) + '</option>';
  });
  html += '</select>';
  return html;
}

// Компактный бейдж лабиринта в строке игрока — вместо целой колонки
function labBadgeHtml(log) {
  var keys  = keysNum(log.labirint);
  var cls   = 'lab-badge' + (keys > 0 || log.labWrong ? ' lab-badge-bad' : '');
  var text  = log.labirint === '' ? LAB_LABEL_EMPTY : String(keys);
  var marks = (log.labWrong ? '<span class="lab-mark">⚠</span>' : '') +
              (log.labComment ? '<span class="lab-mark">💬</span>' : '');
  var title = 'Штрафные ключи: ' + text +
              (log.labWrong ? ', отбивал не туда' : '') +
              (log.labComment ? '\n' + log.labComment : '');
  return '<button class="' + cls + '" data-action="lab" title="' + esc(title) + '">🌀 ' + text + marks + '</button>';
}

function emptyRowHtml(cols, text) {
  return '<tr><td colspan="' + cols + '" class="empty-state">' + esc(text) + '</td></tr>';
}

function renderPlayers() {
  var list = visiblePlayers();
  var rows = '';

  list.forEach(function(player, idx) {
    var log      = currentLog(player.nick);
    var bg       = getRowBg(player);
    var bgStyle  = bg ? ' style="background:' + bg + '"' : '';
    // В ретро-режиме отпуск не блокирует редактирование (прошлая дата)
    var disabled = state.retroDate ? false : player.onVacation;
    var disAttr  = disabled ? ' disabled' : '';
    var roleBadge = player.role === 'Заместитель' ? '<span class="role-badge">Зам</span>' : '';
    var vkDot     = player.inVkGroup === false ? '<span class="vk-dot" title="Нет в группе ВК"></span>' : '';
    var vacClass  = player.onVacation ? ' vacation-active' : '';

    rows += '<tr data-nick="' + esc(player.nick) + '"' + bgStyle + '>';
    rows += '<td class="num-cell">' + (idx + 1) + '</td>';
    rows += '<td class="nick-cell">' + roleBadge + vkDot + warnFlagHtml(player) +
            '<span class="nick-text">' + esc(player.nick) + '</span></td>';
    rows += '<td class="miss-cell miss-border-l' + getMissClass(player.skipT) + '">' + (player.skipT || 0) + '</td>';
    rows += '<td class="miss-cell' + getMissClass(player.skipL) + '">' + (player.skipL || 0) + '</td>';
    rows += '<td class="miss-cell miss-border-r' + getMissClass(player.skipP) + '">' + (player.skipP || 0) + '</td>';
    rows += '<td class="check-cell"><input type="checkbox" class="torg-cb"' + (log.torg ? ' checked' : '') + disAttr + '></td>';
    rows += '<td class="lab-cell">' + labBadgeHtml(log) + '</td>';
    rows += '<td class="check-cell"><input type="checkbox" class="pohod-cb"' + (log.pohod ? ' checked' : '') + disAttr + '></td>';
    rows += '<td class="actions-cell">';
    if (!state.retroDate) {
      rows += '<button class="icon-btn" data-action="edit"     title="Редактировать">✏️</button>';
      rows += '<button class="icon-btn' + (player.warnActive ? ' warn-active' : '') + '" data-action="warning" title="Предупреждение">🚩</button>';
      rows += '<button class="icon-btn' + vacClass + '" data-action="vacation" title="Отпуск">🏖️</button>';
      rows += '<button class="icon-btn" data-action="delete"   title="Удалить">❌</button>';
    }
    rows += '</td>';
    rows += '</tr>';
  });

  if (!rows) {
    rows = emptyRowHtml(9, state.filter ? 'Никто не найден' : 'Нет игроков. Добавьте первого участника.');
  }

  var html =
    '<div class="table-wrapper"><table class="player-table">' +
    '<thead><tr>' +
    '<th class="num-th">#</th>' +
    '<th class="nick-th">Игрок</th>' +
    '<th class="miss-th miss-border-l" title="Пропуски торга">Т↓</th>' +
    '<th class="miss-th" title="Штрафные ключи лабиринта за 7 дней">Л↓</th>' +
    '<th class="miss-th miss-border-r" title="Пропуски похода">П↓</th>' +
    '<th class="check-th">Торг</th>' +
    '<th class="lab-th">Лабиринт</th>' +
    '<th class="check-th">Поход</th>' +
    '<th class="actions-th"></th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div>';

  el('player-list').innerHTML = html;

  // Делегирование событий
  var tbody = el('player-list').querySelector('tbody');
  if (tbody) {
    tbody.addEventListener('change', onTodayChange);
    tbody.addEventListener('click',  onTodayClick);
  }

  renderSummary();
}

function onTodayChange(e) {
  var row  = e.target.closest('tr');
  if (!row) return;
  var nick = row.dataset.nick;
  if (!nick) return;

  if (e.target.classList.contains('torg-cb')) {
    setLog(nick, { torg: e.target.checked });
  } else if (e.target.classList.contains('pohod-cb')) {
    setLog(nick, { pohod: e.target.checked });
  } else {
    return;
  }

  updateRowPreview(nick);
}

function onTodayClick(e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  var row    = btn.closest('tr');
  var nick   = row && row.dataset.nick;
  if (!nick) return;
  var action = btn.dataset.action;
  if (action === 'edit')     openEditModal(nick);
  if (action === 'delete')   openDeleteConfirm(nick);
  if (action === 'vacation') openVacationModal(nick);
  if (action === 'warning')  openWarningModal(nick);
  if (action === 'lab')      openLabModal(nick);
}

// Точечное обновление строки без перерисовки таблицы
function updateRowPreview(nick) {
  var rows = el('player-list').querySelectorAll('tr[data-nick]');
  var row = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].dataset.nick === nick) { row = rows[i]; break; }
  }
  if (!row) { renderSummary(); return; }

  var player = state.players.find(function(p) { return p.nick === nick; });
  if (!player) return;

  var cells  = row.querySelectorAll('.miss-cell');
  var fields = ['torg', 'labirint', 'pohod'];
  cells.forEach(function(cell, idx) {
    var count = getPreviewSkip(player, fields[idx]);
    cell.textContent = count;
    cell.classList.remove('miss-1', 'miss-2', 'miss-3');
    var cls = getMissClass(count).trim();
    if (cls) cell.classList.add(cls);
  });

  var labCell = row.querySelector('.lab-cell');
  if (labCell) labCell.innerHTML = labBadgeHtml(currentLog(nick));

  renderSummary();
}

// Сводка дня
function renderSummary() {
  var box = el('day-summary');
  if (!box) return;

  if (state.players.length === 0) { box.textContent = ''; return; }

  var torg = 0, pohod = 0, keys = 0, warns = 0;
  state.players.forEach(function(player) {
    var log = currentLog(player.nick);
    if (log.torg)  torg++;
    if (log.pohod) pohod++;
    keys += keysNum(log.labirint);
    if (player.warnActive) warns++;
  });

  var shown = visiblePlayers().length;
  var parts = [];
  parts.push(state.filter ? ('показано ' + shown + ' из ' + state.players.length)
                          : (state.players.length + ' игроков'));
  parts.push('🛒 ' + torg);
  parts.push('🌀 ' + keys);
  parts.push('🚩 ' + pohod);
  if (warns > 0) parts.push('⚠ ' + warns);

  box.textContent = parts.join(' · ');
}

// Экран лабиринта
function renderLab() {
  var list = visiblePlayers();
  var rows = '';

  list.forEach(function(player) {
    var log      = currentLog(player.nick);
    var disabled = state.retroDate ? false : player.onVacation;
    var disAttr  = disabled ? ' disabled' : '';
    var bg       = getRowBg(player);
    var bgStyle  = bg ? ' style="background:' + bg + '"' : '';
    var keysCls  = keysNum(log.labirint) > 0 ? ' lab-keys-bad' : '';

    rows += '<tr data-nick="' + esc(player.nick) + '"' + bgStyle + '>';
    rows += '<td class="nick-cell">' + warnFlagHtml(player) +
            '<span class="nick-text">' + esc(player.nick) + '</span></td>';
    rows += '<td class="miss-cell' + getMissClass(player.skipL) + '">' + (player.skipL || 0) + '</td>';
    rows += '<td class="lab-cell' + keysCls + '">' + buildLabSelect(log.labirint, disabled) + '</td>';
    rows += '<td class="check-cell"><input type="checkbox" class="lab-wrong-cb"' +
            (log.labWrong ? ' checked' : '') + disAttr + '></td>';
    rows += '<td class="lab-comment-cell"><input type="text" class="lab-comment-input" ' +
            'placeholder="замечание" value="' + esc(log.labComment) + '"' + disAttr + '></td>';
    rows += '</tr>';
  });

  if (!rows) {
    rows = emptyRowHtml(5, state.filter ? 'Никто не найден' : 'Нет игроков.');
  }

  var html =
    '<div class="lab-hint">Ставим <b>штрафные</b> ключи: не отбитые плюс отбитые не туда. ' +
    '0 или «' + LAB_LABEL_EMPTY + '» — претензий нет.</div>' +
    '<div class="table-wrapper"><table class="player-table lab-table">' +
    '<thead><tr>' +
    '<th class="nick-th">Игрок</th>' +
    '<th class="miss-th" title="Штрафные ключи за 7 дней">Σ 7дн</th>' +
    '<th class="lab-th">Ключи</th>' +
    '<th class="check-th">Не туда</th>' +
    '<th class="lab-comment-th">Замечание</th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div>';

  el('player-list').innerHTML = html;

  var tbody = el('player-list').querySelector('tbody');
  if (tbody) {
    tbody.addEventListener('change', onLabChange);
    tbody.addEventListener('input',  onLabChange);
  }

  renderSummary();
}

function onLabChange(e) {
  var row  = e.target.closest('tr');
  if (!row) return;
  var nick = row.dataset.nick;
  if (!nick) return;

  if (e.target.classList.contains('lab-select')) {
    setLog(nick, { labirint: e.target.value });
    row.querySelector('.lab-cell').classList.toggle('lab-keys-bad', keysNum(e.target.value) > 0);
  } else if (e.target.classList.contains('lab-wrong-cb')) {
    setLog(nick, { labWrong: e.target.checked });
  } else if (e.target.classList.contains('lab-comment-input')) {
    setLog(nick, { labComment: e.target.value });
  } else {
    return;
  }

  var missCell = row.querySelector('.miss-cell');
  if (missCell) {
    var player = state.players.find(function(p) { return p.nick === nick; });
    if (player) {
      var count = getPreviewSkip(player, 'labirint');
      missCell.textContent = count;
      missCell.classList.remove('miss-1', 'miss-2', 'miss-3');
      var cls = getMissClass(count).trim();
      if (cls) missCell.classList.add(cls);
    }
  }

  renderSummary();
}

// Модалка лабиринта на одного игрока
function openLabModal(nick) {
  var player = state.players.find(function(p) { return p.nick === nick; });
  if (!player) return;
  var log = currentLog(nick);

  state.modalNick = nick;
  el('lab-modal-nick').textContent = nick;
  el('lab-keys').innerHTML = labOptions().map(function(v) {
    return '<option value="' + esc(v) + '"' + (log.labirint === v ? ' selected' : '') + '>' +
           esc(v === '' ? LAB_LABEL_EMPTY : v) + '</option>';
  }).join('');
  el('lab-wrong').checked = log.labWrong;
  el('lab-comment').value = log.labComment;

  showModal('modal-lab');
}

function submitLab() {
  var nick = state.modalNick;
  if (!nick) return;

  setLog(nick, {
    labirint:   el('lab-keys').value,
    labWrong:   el('lab-wrong').checked,
    labComment: el('lab-comment').value.trim(),
  });

  state.modalNick = null;
  closeModal();
  updateRowPreview(nick);
}

// Модалка предупреждения
function openWarningModal(nick) {
  var player = state.players.find(function(p) { return p.nick === nick; });
  if (!player) return;

  state.modalNick = nick;
  el('warning-modal-nick').textContent = nick;
  el('warning-active').checked = player.warnActive;
  el('warning-date').value     = player.warnDate || localIso(new Date());
  el('warning-reason').value   = player.warnReason || '';
  el('warning-date').disabled   = !player.warnActive;
  el('warning-reason').disabled = !player.warnActive;

  var count = warnDisplayCount(player);
  el('warning-count').textContent = count > 0
    ? 'Предупреждений за 7 дней: ' + count
    : 'За последние 7 дней предупреждений не было';

  showModal('modal-warning');
}

async function submitWarning() {
  var nick   = state.modalNick;
  if (!nick) return;
  var active = el('warning-active').checked;
  var date   = el('warning-date').value;
  var reason = el('warning-reason').value.trim();

  if (active && !date) {
    showToast('Укажите дату выдачи', 'error');
    return;
  }

  state.modalNick = null;
  closeModal();
  showLoading();
  try {
    await api('setWarning', { nick, active, date, reason });
    await loadData();
    showToast(active ? 'Предупреждение выдано' : 'Предупреждение снято', 'success');
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

// Текущий день - сохранение
async function saveLogs(isAuto) {
  cancelAutoSave();
  if (Object.keys(state.editedLogs).length === 0) {
    if (!isAuto) showToast('Нет несохранённых изменений', 'info');
    return;
  }
  showLoading();
  try {
    await api('saveLogs', { logs: state.editedLogs });
    state.editedLogs = {};
    showToast(isAuto ? 'Автосохранение ✓' : 'Сохранено ✓', 'success');
    await loadData();
  } catch (err) {
    showToast('Ошибка сохранения: ' + err.message, 'error');
    hideLoading();
  }
}

function saveCurrent() {
  if (state.retroDate) saveRetroDay();
  else saveLogs();
}

// Добавление игрока
function openAddModal() {
  el('add-nick').value = '';
  document.querySelector('input[name="add-role"][value=""]').checked = true;
  el('add-is-temp').checked = false;
  showModal('modal-add');
  el('add-nick').focus();
}

async function submitAddPlayer() {
  var nick   = el('add-nick').value.trim();
  if (!nick) { showToast('Введите ник', 'error'); return; }
  var role   = document.querySelector('input[name="add-role"]:checked').value;
  var isTemp = el('add-is-temp').checked;

  closeModal();
  showLoading();
  try {
    await api('addPlayer', { nick, role, isTemp });
    await loadData();
    showToast('Игрок добавлен', 'success');
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

// Редактирование игрока
function openEditModal(nick) {
  var player = state.players.find(function(p) { return p.nick === nick; });
  if (!player) return;

  el('edit-old-nick').value  = nick;
  el('edit-nick').value      = nick;
  el('edit-is-temp').checked = player.isTemp;
  el('edit-in-vk').checked   = player.inVkGroup;

  var roleVal = player.role === 'Заместитель' ? 'Заместитель' : '';
  var radios  = document.querySelectorAll('input[name="edit-role"]');
  radios.forEach(function(r) { r.checked = (r.value === roleVal); });

  showModal('modal-edit');
  el('edit-nick').focus();
}

async function submitEditPlayer() {
  var oldNick = el('edit-old-nick').value;
  var newNick = el('edit-nick').value.trim();
  if (!newNick) { showToast('Введите ник', 'error'); return; }
  var role   = document.querySelector('input[name="edit-role"]:checked').value;
  var isTemp    = el('edit-is-temp').checked;
  var inVkGroup = el('edit-in-vk').checked;

  closeModal();
  showLoading();
  try {
    await api('updatePlayer', { oldNick, newNick, role, isTemp, inVkGroup });
    await loadData();
    showToast('Изменения сохранены', 'success');
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

// Удаление игрока
function openDeleteConfirm(nick) {
  el('confirm-title').textContent   = 'Удалить игрока';
  el('confirm-message').textContent =
    'Удалить игрока «' + nick + '»? Данные в архиве сохранятся.';

  state.confirmCb = async function() {
    showLoading();
    try {
      await api('deletePlayer', { nick });
      await loadData();
      showToast('Игрок удалён', 'success');
    } catch (err) {
      showToast('Ошибка: ' + err.message, 'error');
    } finally {
      hideLoading();
    }
  };
  showModal('modal-confirm');
}

// Отпуск
function openVacationModal(nick) {
  var player = state.players.find(function(p) { return p.nick === nick; });
  if (!player) return;

  el('vacation-nick').value         = nick;
  el('vacation-active').checked     = player.onVacation;
  el('vacation-return-date').value  = player.returnDate ? displayToIso(player.returnDate) : '';
  el('vacation-return-date').disabled = !player.onVacation;

  showModal('modal-vacation');
}

async function submitVacation() {
  var nick       = el('vacation-nick').value;
  var active     = el('vacation-active').checked;
  var returnDate = el('vacation-return-date').value; // ISO format

  // Оптимистичное обновление — сразу отображаем в таблице
  var playerIdx = state.players.findIndex(function(p) { return p.nick === nick; });
  var prevPlayer = playerIdx >= 0 ? Object.assign({}, state.players[playerIdx]) : null;
  if (playerIdx >= 0) {
    state.players[playerIdx].onVacation = active;
    state.players[playerIdx].returnDate = active ? isoToDisplay(returnDate) : '';
  }
  closeModal();
  renderApp();

  showLoading();
  try {
    if (active) {
      await api('setVacation', { nick, returnDate });
    } else {
      await api('cancelVacation', { nick });
    }
    showToast('Отпуск обновлён', 'success');
    await loadData();
  } catch (err) {
    // Откатываем оптимистичное обновление
    if (playerIdx >= 0 && prevPlayer) {
      state.players[playerIdx] = prevPlayer;
      renderApp();
    }
    showToast('Ошибка: ' + err.message, 'error');
    hideLoading();
  }
}

// Завершить день
function openEndDayConfirm() {
  el('confirm-title').textContent   = 'Завершить день';
  el('confirm-message').textContent =
    'Все отметки будут перенесены в архив, дата сдвинется на следующий день. ' +
    'Это действие нельзя отменить. Продолжить?';

  state.confirmCb = async function() {
    showLoading();
    try {
      var result = await api('runArchive');
      await loadData();
      showToast('День завершён. Архивировано записей: ' + (result.archived || 0), 'success');
    } catch (err) {
      showToast('Ошибка: ' + err.message, 'error');
    } finally {
      hideLoading();
    }
  };
  showModal('modal-confirm');
}

// Режим архива
function enterArchiveMode() {
  state.mode            = 'archive';
  state.archiveEditMode = false;
  state.archiveEdits    = {};
  state.archiveGroups   = [];

  el('btn-edit-archive').classList.add('hidden');
  el('btn-save-archive').classList.add('hidden');
  el('btn-cancel-archive').classList.add('hidden');

  renderApp();

  // По умолчанию — последние 7 дней
  var today = new Date();
  var toDate   = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  var fromDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);

  var todayIso = localIso(today);
  el('archive-date-from').max   = todayIso;
  el('archive-date-to').max     = todayIso;
  el('archive-date-from').value = localIso(fromDate);
  el('archive-date-to').value   = localIso(toDate);

  state.archiveFromDate = isoToDisplay(localIso(fromDate));
  state.archiveToDate   = isoToDisplay(localIso(toDate));

  loadArchiveRange(state.archiveFromDate, state.archiveToDate);
}

async function loadArchiveRange(fromDate, toDate) {
  var dates = getDateRange(fromDate, toDate);
  if (dates.length === 0) return;

  showLoading();
  try {
    var results = await Promise.all(dates.map(function(d) {
      return api('getArchive', { date: d }).catch(function() { return []; });
    }));

    state.archiveGroups = dates.map(function(d, i) {
      return { date: d, entries: results[i] || [] };
    }).filter(function(g) { return g.entries.length > 0; });

    state.archiveEdits = {};

    // Для режима редактирования: данные самой свежей даты (toDate = dates[0])
    state.archiveData = results[0] || [];

    if (!state.archiveEditMode) {
      el('btn-edit-archive').classList.remove('hidden');
    }

    renderArchive();
  } catch (err) {
    showToast('Ошибка загрузки архива: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

function buildArchiveTable(entries, edit) {
  var rows = '';
  entries.forEach(function(entry) {
    var e = Object.assign({}, entry, state.archiveEdits[entry.nick] || {});

    rows += '<tr data-nick="' + esc(entry.nick) + '">';

    if (edit) {
      rows += '<td class="nick-cell"><span class="nick-text">' + esc(entry.nick) + '</span></td>';
      rows += '<td class="check-cell"><input type="checkbox" class="torg-cb"' + (e.torg ? ' checked' : '') + '></td>';
      rows += '<td class="lab-cell">' + buildLabSelect(e.labirint, false) + '</td>';
      rows += '<td class="check-cell"><input type="checkbox" class="lab-wrong-cb"' + (e.labWrong ? ' checked' : '') + '></td>';
      rows += '<td class="lab-comment-cell"><input type="text" class="lab-comment-input" value="' + esc(e.labComment || '') + '"></td>';
      rows += '<td class="check-cell"><input type="checkbox" class="pohod-cb"' + (e.pohod ? ' checked' : '') + '></td>';
      rows += '<td class="check-cell"><input type="checkbox" class="warn-cb"' + (e.warning ? ' checked' : '') + '></td>';
    } else {
      // torg/pohod: true = пропуск → красный ❌, false = присутствовал → пусто
      var warnMark = e.warning
        ? '<span class="warn-flag warn-fresh" title="' + esc(e.warnReason || 'Предупреждение') + '">🚩</span>'
        : '';
      var keys = keysNum(e.labirint);
      rows += '<td class="nick-cell">' + warnMark + '<span class="nick-text">' + esc(entry.nick) + '</span></td>';
      rows += '<td class="check-cell' + (e.torg ? ' arch-miss' : '') + '">' + (e.torg ? '❌' : '') + '</td>';
      rows += '<td class="lab-cell' + (keys > 0 ? ' arch-miss' : '') + '">' + (e.labirint === '' ? '' : esc(String(keys))) + '</td>';
      rows += '<td class="check-cell' + (e.labWrong ? ' arch-miss' : '') + '">' + (e.labWrong ? '⚠' : '') + '</td>';
      rows += '<td class="lab-comment-cell">' + esc(e.labComment || '') + '</td>';
      rows += '<td class="check-cell' + (e.pohod ? ' arch-miss' : '') + '">' + (e.pohod ? '❌' : '') + '</td>';
      rows += '<td class="check-cell">' + (e.warning ? '🚩' : '') + '</td>';
    }

    rows += '</tr>';
  });

  return '<div class="table-wrapper"><table class="player-table archive-table">' +
    '<thead><tr>' +
    '<th class="nick-th">Игрок</th>' +
    '<th class="check-th">Торг</th>' +
    '<th class="lab-th">Ключи</th>' +
    '<th class="check-th">Не туда</th>' +
    '<th class="lab-comment-th">Замечание</th>' +
    '<th class="check-th">Поход</th>' +
    '<th class="check-th">Предупр.</th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div>';
}

function renderArchive() {
  var container = el('player-list');

  if (!state.archiveGroups || state.archiveGroups.length === 0) {
    container.innerHTML = '<p class="empty-state">Нет записей за выбранный период</p>';
    return;
  }

  var isSingle = getDateRange(state.archiveFromDate, state.archiveToDate).length === 1;

  if (isSingle && state.archiveEditMode) {
    container.innerHTML = buildArchiveTable(state.archiveData, true);
    var tbody = container.querySelector('tbody');
    if (tbody) {
      tbody.addEventListener('change', onArchiveChange);
      tbody.addEventListener('input',  onArchiveChange);
    }
    return;
  }

  if (isSingle) {
    container.innerHTML = buildArchiveTable(state.archiveGroups[0].entries, false);
    return;
  }

  // Диапазон — группы по датам
  var html = '';
  state.archiveGroups.forEach(function(group) {
    html += '<div class="archive-group">';
    html += '<div class="archive-group-header">' + esc(group.date) + '</div>';
    html += buildArchiveTable(group.entries, false);
    html += '</div>';
  });
  container.innerHTML = html;
}

function onArchiveChange(e) {
  var row  = e.target.closest('tr');
  if (!row) return;
  var nick = row.dataset.nick;
  if (!nick) return;

  var original = state.archiveData.find(function(x) { return x.nick === nick; }) || {};
  if (!state.archiveEdits[nick]) {
    state.archiveEdits[nick] = Object.assign({}, original);
  }
  var edit = state.archiveEdits[nick];

  if (e.target.classList.contains('torg-cb'))              edit.torg       = e.target.checked;
  else if (e.target.classList.contains('lab-select'))      edit.labirint   = e.target.value;
  else if (e.target.classList.contains('lab-wrong-cb'))    edit.labWrong   = e.target.checked;
  else if (e.target.classList.contains('lab-comment-input')) edit.labComment = e.target.value;
  else if (e.target.classList.contains('pohod-cb'))        edit.pohod      = e.target.checked;
  else if (e.target.classList.contains('warn-cb'))         edit.warning    = e.target.checked;
}

function enterArchiveEditMode() {
  // В диапазонном режиме схлопываемся на самую свежую дату (archiveToDate)
  if (state.archiveFromDate !== state.archiveToDate) {
    state._editFromDateSaved = state.archiveFromDate; // запомним для отмены
    state.archiveFromDate = state.archiveToDate;
    el('archive-date-from').value = displayToIso(state.archiveToDate);
  }

  state.archiveEditMode = true;
  state.archiveEdits    = {};
  el('btn-edit-archive').classList.add('hidden');
  el('btn-save-archive').classList.remove('hidden');
  el('btn-cancel-archive').classList.remove('hidden');
  renderArchive();
}

function cancelArchiveEdit() {
  state.archiveEditMode = false;
  state.archiveEdits    = {};
  el('btn-edit-archive').classList.remove('hidden');
  el('btn-save-archive').classList.add('hidden');
  el('btn-cancel-archive').classList.add('hidden');

  // Восстанавливаем диапазон, если схлопывали
  if (state._editFromDateSaved) {
    state.archiveFromDate = state._editFromDateSaved;
    el('archive-date-from').value = displayToIso(state._editFromDateSaved);
    state._editFromDateSaved = null;
  }

  loadArchiveRange(state.archiveFromDate, state.archiveToDate);
}

async function saveArchiveChanges() {
  var nicks = Object.keys(state.archiveEdits);
  if (nicks.length === 0) {
    showToast('Нет изменений', 'info');
    cancelArchiveEdit();
    return;
  }

  showLoading();
  try {
    for (var i = 0; i < nicks.length; i++) {
      var nick = nicks[i];
      await api('updateArchive', {
        date:  state.archiveFromDate,
        nick:  nick,
        entry: state.archiveEdits[nick],
      });
    }

    // Применяем изменения к локальным данным
    state.archiveData = state.archiveData.map(function(entry) {
      return state.archiveEdits[entry.nick]
        ? Object.assign({}, entry, state.archiveEdits[entry.nick])
        : entry;
    });
    if (state.archiveGroups.length > 0) {
      state.archiveGroups[0].entries = state.archiveData.slice();
    }

    cancelArchiveEdit();
    showToast('Архив обновлён ✓', 'success');
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

// Модальные окна
function showModal(id) {
  // Скрываем все модальные окна, показываем нужное
  document.querySelectorAll('.modal').forEach(function(m) { m.classList.add('hidden'); });
  el(id).classList.remove('hidden');
  el('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  el('modal-overlay').classList.add('hidden');
  document.querySelectorAll('.modal').forEach(function(m) { m.classList.add('hidden'); });
}

// Тёмная тема
function initTheme() {
  if (localStorage.getItem('theme') === 'dark') {
    document.body.classList.add('dark-theme');
    el('btn-theme').textContent = '☀️';
    el('btn-theme').title = 'Светлая тема';
  }
}

function toggleTheme() {
  var dark = document.body.classList.toggle('dark-theme');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
  el('btn-theme').textContent = dark ? '☀️' : '🌙';
  el('btn-theme').title = dark ? 'Светлая тема' : 'Тёмная тема';
}

// Инициализация
document.addEventListener('DOMContentLoaded', function() {

  initTheme();
  el('btn-theme').addEventListener('click', toggleTheme);

  // --- Восстанавливаем сессию ---
  var urlParams = new URLSearchParams(location.search);
  var tableId   = urlParams.get('table') || localStorage.getItem('spreadsheetId');

  if (tableId) {
    state.spreadsheetId = tableId;
    loadData();
  } else {
    showStartPage();
  }

  // Стартовая страница
  el('btn-connect').addEventListener('click', function() {
    connectToSpreadsheet(el('spreadsheet-id-input').value);
  });

  el('spreadsheet-id-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') connectToSpreadsheet(el('spreadsheet-id-input').value);
  });

  el('btn-create-clan').addEventListener('click', function() {
    createClan(el('clan-name-input').value, el('owner-email-input').value);
  });

  // Шапка
  el('btn-archive').addEventListener('click', enterArchiveMode);

  el('btn-lab').addEventListener('click', function() {
    state.mode = 'lab';
    renderApp();
  });

  el('btn-today').addEventListener('click', function() {
    if (state.mode === 'lab') {
      state.mode = 'today';
      renderApp();
    } else {
      state.mode = 'today';
      loadData();
    }
  });

  el('btn-leave').addEventListener('click', function() {
    localStorage.removeItem('spreadsheetId');
    localStorage.removeItem('clanName');
    state.spreadsheetId = null;
    state.clanName      = null;
    history.replaceState({}, '', location.pathname);
    showStartPage();
  });

  // Панель текущего дня
  el('btn-add-player').addEventListener('click', openAddModal);
  el('btn-save').addEventListener('click', saveCurrent);
  el('btn-refresh').addEventListener('click', loadData);

  // Панель лабиринта
  el('btn-lab-save').addEventListener('click', saveCurrent);
  el('btn-lab-refresh').addEventListener('click', loadData);

  // Поиск по нику
  el('search-input').addEventListener('input', function(e) {
    state.filter = e.target.value;
    if (state.mode === 'lab') renderLab();
    else renderPlayers();
  });

  el('search-clear').addEventListener('click', function() {
    state.filter = '';
    el('search-input').value = '';
    if (state.mode === 'lab') renderLab();
    else renderPlayers();
  });

  // Ретро-режим
  el('retro-date-picker').addEventListener('change', function(e) {
    var val = e.target.value;
    if (!val) { if (state.retroDate) exitRetroMode(); return; }
    enterRetroMode(val);
  });
  el('btn-retro-today').addEventListener('click', exitRetroMode);

  // Панель архива
  function onArchiveDateChange() {
    state.archiveEditMode = false;
    state.archiveEdits    = {};
    el('btn-edit-archive').classList.add('hidden');
    el('btn-save-archive').classList.add('hidden');
    el('btn-cancel-archive').classList.add('hidden');
    loadArchiveRange(state.archiveFromDate, state.archiveToDate);
  }

  el('archive-date-from').addEventListener('change', function(e) {
    state.archiveFromDate = isoToDisplay(e.target.value);
    onArchiveDateChange();
  });

  el('archive-date-to').addEventListener('change', function(e) {
    state.archiveToDate = isoToDisplay(e.target.value);
    onArchiveDateChange();
  });

  el('btn-edit-archive').addEventListener('click',   enterArchiveEditMode);
  el('btn-save-archive').addEventListener('click',   saveArchiveChanges);
  el('btn-cancel-archive').addEventListener('click', cancelArchiveEdit);

  // Модальные окна - общие
  el('modal-overlay').addEventListener('click', function(e) {
    if (e.target === el('modal-overlay')) closeModal();
  });

  document.querySelectorAll('.modal-close').forEach(function(btn) {
    btn.addEventListener('click', closeModal);
  });

  // Модальное окно - добавить игрока
  el('btn-add-cancel').addEventListener('click', closeModal);
  el('btn-add-submit').addEventListener('click', submitAddPlayer);

  el('add-nick').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') submitAddPlayer();
  });

  // Модальное окно - редактировать игрока
  el('btn-edit-cancel').addEventListener('click', closeModal);
  el('btn-edit-submit').addEventListener('click', submitEditPlayer);

  el('edit-nick').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') submitEditPlayer();
  });

  // Модальное окно - отпуск
  el('btn-vacation-cancel').addEventListener('click', closeModal);
  el('btn-vacation-submit').addEventListener('click', submitVacation);

  el('vacation-active').addEventListener('change', function(e) {
    el('vacation-return-date').disabled = !e.target.checked;
    if (!e.target.checked) el('vacation-return-date').value = '';
  });

  // Модальное окно - лабиринт
  el('btn-lab-cancel').addEventListener('click', function() {
    state.modalNick = null;
    closeModal();
  });
  el('btn-lab-submit').addEventListener('click', submitLab);

  // Модальное окно - предупреждение
  el('btn-warning-cancel').addEventListener('click', function() {
    state.modalNick = null;
    closeModal();
  });
  el('btn-warning-submit').addEventListener('click', submitWarning);

  el('warning-active').addEventListener('change', function(e) {
    el('warning-date').disabled   = !e.target.checked;
    el('warning-reason').disabled = !e.target.checked;
    if (e.target.checked && !el('warning-date').value) {
      el('warning-date').value = localIso(new Date());
    }
  });

  // Модальное окно - подтверждение
  el('btn-confirm-cancel').addEventListener('click', function() {
    closeModal();
    state.confirmCb = null;
  });

  el('btn-confirm-ok').addEventListener('click', function() {
    closeModal();
    var cb = state.confirmCb;
    state.confirmCb = null;
    if (cb) cb();
  });

});
