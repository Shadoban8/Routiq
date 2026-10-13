/* ==========================================================================
   ROUTIQ — script.js
   Sections: constants · helpers · storage · state · selectors · rendering ·
   task form · habits · focus timer · settings · navigation · events · init
   ========================================================================== */
(() => {
  'use strict';

  /* ---------- Constants ---------- */
  const STORAGE_KEYS = {
    tasks: 'routiq.tasks.v1',
    habits: 'routiq.habits.v1',
    settings: 'routiq.settings.v1',
  };
  const CATEGORIES = ['Work', 'Health', 'Learning', 'Personal', 'Home', 'Other'];
  const VIEWS = {
    dashboard: 'Dashboard',
    routine: 'My Routine',
    habits: 'My Habits',
    focus: 'Focus Mode',
    progress: 'Progress',
    settings: 'Settings',
  };
  const DEFAULT_SETTINGS = { theme: 'light', timeFormat: '12', name: '' };
  const MAX_TASK_MINUTES = 1440;
  const MAX_FOCUS_MINUTES = 240;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 88;

  /* ---------- DOM helpers ---------- */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const escapeHTML = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const icon = (name) =>
    `<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

  /* ---------- Date & time helpers ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const toDateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDateKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (key, n) => {
    const d = parseDateKey(key);
    d.setDate(d.getDate() + n);
    return toDateKey(d);
  };
  const isValidDateKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toDateKey(parseDateKey(s)) === s;
  const isValidTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const timeToMinutes = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const nowMinutes = () => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  };
  const formatDateLabel = (key, options) => parseDateKey(key).toLocaleDateString(undefined, options);

  function formatTime(t) {
    if (state.settings.timeFormat === '24') return t;
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
  }

  function formatDuration(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function relativeDayLabel(key) {
    if (key === state.today) return 'Today';
    if (key === addDays(state.today, 1)) return 'Tomorrow';
    if (key === addDays(state.today, -1)) return 'Yesterday';
    return formatDateLabel(key, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  const createId = () =>
    (window.crypto && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  /* ---------- State ---------- */
  const state = {
    tasks: [],
    habits: [],
    settings: { ...DEFAULT_SETTINGS },
    view: 'dashboard',
    today: toDateKey(),
    routineDate: toDateKey(),
    editingTaskId: null,
    storageOk: true,
    lastSignature: '',
  };

  /* ---------- Storage ---------- */
  function storageAvailable() {
    try {
      const probe = '__routiq_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch (_) {
      return false;
    }
  }

  function readStorage(key, sanitize, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return sanitize(JSON.parse(raw));
    } catch (_) {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      if (state.storageOk) {
        state.storageOk = false;
        toast('Could not save to browser storage. Changes may be lost on refresh.', 'error');
      }
      return false;
    }
  }

  function sanitizeTasks(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    return raw
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        id: typeof t.id === 'string' && t.id ? t.id : createId(),
        title: typeof t.title === 'string' ? t.title.trim().slice(0, 80) : '',
        date: isValidDateKey(t.date) ? t.date : toDateKey(),
        time: isValidTime(t.time) ? t.time : '09:00',
        duration: Number.isInteger(t.duration) && t.duration >= 1 && t.duration <= MAX_TASK_MINUTES ? t.duration : 30,
        category: CATEGORIES.includes(t.category) ? t.category : 'Other',
        completed: t.completed === true,
      }))
      .filter((t) => {
        if (!t.title || seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
  }

  function sanitizeHabits(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    return raw
      .filter((h) => h && typeof h === 'object')
      .map((h) => {
        const history = {};
        if (h.history && typeof h.history === 'object' && !Array.isArray(h.history)) {
          Object.keys(h.history).forEach((k) => {
            if (isValidDateKey(k) && h.history[k] === true) history[k] = true;
          });
        }
        return {
          id: typeof h.id === 'string' && h.id ? h.id : createId(),
          name: typeof h.name === 'string' ? h.name.trim().slice(0, 60) : '',
          createdOn: isValidDateKey(h.createdOn) ? h.createdOn : toDateKey(),
          history,
        };
      })
      .filter((h) => {
        if (!h.name || seen.has(h.id)) return false;
        seen.add(h.id);
        return true;
      });
  }

  function sanitizeSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      theme: ['light', 'dark', 'system'].includes(s.theme) ? s.theme : DEFAULT_SETTINGS.theme,
      timeFormat: ['12', '24'].includes(s.timeFormat) ? s.timeFormat : DEFAULT_SETTINGS.timeFormat,
      name: typeof s.name === 'string' ? s.name.trim().slice(0, 40) : '',
    };
  }

  const saveTasks = () => writeStorage(STORAGE_KEYS.tasks, state.tasks);
  const saveHabits = () => writeStorage(STORAGE_KEYS.habits, state.habits);
  const saveSettings = () => writeStorage(STORAGE_KEYS.settings, state.settings);

  function loadAll() {
    state.tasks = readStorage(STORAGE_KEYS.tasks, sanitizeTasks, []);
    state.habits = readStorage(STORAGE_KEYS.habits, sanitizeHabits, []);
    state.settings = readStorage(STORAGE_KEYS.settings, sanitizeSettings, { ...DEFAULT_SETTINGS });
  }

  /* ---------- Selectors & calculations ---------- */
  const compareTasks = (a, b) => a.time.localeCompare(b.time) || a.title.localeCompare(b.title);
  const tasksForDate = (date) => state.tasks.filter((t) => t.date === date).sort(compareTasks);
  const findTask = (id) => state.tasks.find((t) => t.id === id);
  const findHabit = (id) => state.habits.find((h) => h.id === id);

  function dayStats(date) {
    const list = state.tasks.filter((t) => t.date === date);
    const done = list.filter((t) => t.completed).length;
    return {
      total: list.length,
      done,
      remaining: list.length - done,
      percent: list.length ? Math.round((done / list.length) * 100) : 0,
    };
  }

  function taskStatus(task) {
    if (task.completed) return { key: 'done', label: 'Completed' };
    if (task.date < state.today) return { key: 'overdue', label: 'Missed' };
    if (task.date === state.today) {
      const start = timeToMinutes(task.time);
      const now = nowMinutes();
      if (start + task.duration <= now) return { key: 'overdue', label: 'Overdue' };
      if (start <= now) return { key: 'active', label: 'In progress' };
    }
    return { key: 'pending', label: 'Upcoming' };
  }

  function calcStreak(habit) {
    let cursor = habit.history[state.today] ? state.today : addDays(state.today, -1);
    let streak = 0;
    while (habit.history[cursor]) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  const lastNDays = (n) => Array.from({ length: n }, (_, i) => addDays(state.today, i - (n - 1)));

  function weekStats() {
    const days = lastNDays(7).map((date) => ({ date, ...dayStats(date) }));
    const total = days.reduce((sum, d) => sum + d.total, 0);
    const done = days.reduce((sum, d) => sum + d.done, 0);
    return { days, total, done, percent: total ? Math.round((done / total) * 100) : null };
  }

  function habitWeek(habit) {
    const days = lastNDays(7).map((date) => ({
      date,
      eligible: date >= habit.createdOn,
      done: date >= habit.createdOn && habit.history[date] === true,
    }));
    const eligible = days.filter((d) => d.eligible).length;
    const done = days.filter((d) => d.done).length;
    return { days, eligible, done, percent: eligible ? Math.round((done / eligible) * 100) : null };
  }

  function overallHabitConsistency() {
    let eligible = 0;
    let done = 0;
    state.habits.forEach((h) => {
      const w = habitWeek(h);
      eligible += w.eligible;
      done += w.done;
    });
    return { eligible, done, percent: eligible ? Math.round((done / eligible) * 100) : null };
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  /* ---------- Feedback: toast & confirm ---------- */
  function toast(message, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<span>${escapeHTML(message)}</span>`;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
  }

  function confirmAction({ title, message, confirmLabel = 'Delete' }) {
    return new Promise((resolve) => {
      const dialog = $('#confirm-dialog');
      $('#confirm-title').textContent = title;
      $('#confirm-message').textContent = message;
      $('#confirm-accept').textContent = confirmLabel;
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }

  /* ---------- Rendering: shared pieces ---------- */
  function setBar(selector, percent) {
    const bar = $(selector);
    bar.setAttribute('aria-valuenow', String(percent));
    bar.firstElementChild.style.width = `${percent}%`;
  }

  function emptyStateHTML({ iconName = 'routine', title, text, actionHTML = '' }) {
    return `<div class="empty">
      <span class="empty__icon">${icon(iconName)}</span>
      <p class="empty__title">${escapeHTML(title)}</p>
      <p class="empty__text">${escapeHTML(text)}</p>
      ${actionHTML}
    </div>`;
  }

  const addTaskButtonHTML = (label = 'Add task') =>
    `<button type="button" class="btn btn--secondary" data-action="open-task-form">${icon('plus')}${label}</button>`;

  function taskItemHTML(task) {
    const status = taskStatus(task);
    const title = escapeHTML(task.title);
    return `<li>
      <div class="task ${task.completed ? 'is-done' : ''}" data-id="${escapeHTML(task.id)}">
        <button type="button" class="check" data-action="toggle-task" aria-pressed="${task.completed}"
          aria-label="Completed: ${title}" title="${task.completed ? 'Mark as incomplete' : 'Mark as complete'}">
          <span class="check__box">${icon('check')}</span>
        </button>
        <div class="task__main">
          <p class="task__title">${title}</p>
          <p class="task__meta">
            <span class="task__time">${icon('clock')}${formatTime(task.time)}</span>
            <span>${formatDuration(task.duration)}</span>
            <span class="chip">${escapeHTML(task.category)}</span>
            <span class="status status--${status.key}">${status.label}</span>
          </p>
        </div>
        <div class="task__actions">
          <button type="button" class="icon-btn" data-action="edit-task" aria-label="Edit ${title}" title="Edit">${icon('edit')}</button>
          <button type="button" class="icon-btn icon-btn--danger" data-action="delete-task" aria-label="Delete ${title}" title="Delete">${icon('trash')}</button>
        </div>
      </div>
    </li>`;
  }

  function renderTaskList(container, tasks, emptyOptions) {
    container.innerHTML = tasks.length
      ? `<ul class="task-list">${tasks.map(taskItemHTML).join('')}</ul>`
      : emptyStateHTML(emptyOptions);
  }

  function habitItemHTML(habit, { compact = false } = {}) {
    const done = habit.history[state.today] === true;
    const streak = calcStreak(habit);
    const name = escapeHTML(habit.name);
    const streakText = streak > 0 ? `${streak} day${streak === 1 ? '' : 's'} streak` : 'No streak yet';
    return `<li>
      <div class="habit ${done ? 'is-done' : ''}" data-id="${escapeHTML(habit.id)}">
        <button type="button" class="check" data-action="toggle-habit" aria-pressed="${done}"
          aria-label="Done today: ${name}" title="${done ? 'Undo today' : 'Mark done for today'}">
          <span class="check__box">${icon('check')}</span>
        </button>
        <div class="habit__main">
          <p class="habit__name">${name}</p>
          <p class="habit__meta">
            <span class="streak">${icon('flame')}${streakText}</span>
            <span class="status ${done ? 'status--done' : 'status--pending'}">${done ? 'Done today' : 'Not done yet'}</span>
          </p>
        </div>
        ${compact ? '' : `<div class="habit__actions">
          <button type="button" class="icon-btn icon-btn--danger" data-action="delete-habit" aria-label="Delete habit ${name}" title="Delete">${icon('trash')}</button>
        </div>`}
      </div>
    </li>`;
  }

  function renderHabitList(container, { compact = false } = {}) {
    if (!state.habits.length) {
      container.innerHTML = emptyStateHTML({
        iconName: 'habits',
        title: 'No habits yet',
        text: compact ? 'Add a habit to start building a streak.' : 'Add your first habit above to start building a streak.',
        actionHTML: compact ? '<a class="btn btn--secondary" href="#habits">Add a habit</a>' : '',
      });
      return;
    }
    container.innerHTML = `<ul class="habit-list">${state.habits.map((h) => habitItemHTML(h, { compact })).join('')}</ul>`;
  }

  /* ---------- Rendering: views ---------- */
  function renderHeader() {
    const s = dayStats(state.today);
    const name = state.settings.name;
    $('#today-label').textContent = formatDateLabel(state.today, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    $('#greeting').textContent = `${greeting()}${name ? `, ${name}` : ''}`;
    $('#dashboard-summary').textContent = !s.total
      ? 'Nothing is scheduled yet. Add your first task to get started.'
      : s.remaining
        ? `${s.done} of ${s.total} tasks done. ${s.remaining} to go today.`
        : `All ${s.total} tasks done today. Well played.`;
    setBar('#header-bar', s.percent);
    $('#header-progress-text').textContent = s.total ? `${s.done}/${s.total} done · ${s.percent}%` : 'No tasks today';
  }

  function renderOverview() {
    const s = dayStats(state.today);
    $('#stat-total').textContent = s.total;
    $('#stat-done').textContent = s.done;
    $('#stat-remaining').textContent = s.remaining;
    $('#stat-percent').textContent = `${s.percent}%`;
    setBar('#stat-bar', s.percent);
  }

  function renderNextTask() {
    const el = $('#next-task');
    const todays = tasksForDate(state.today);
    const next = todays.find((t) => !t.completed);

    if (!todays.length) {
      el.innerHTML = `<p class="next-card__label" id="next-heading">Up next</p>
        <h2 class="next-card__title">Nothing scheduled today</h2>
        <p class="next-card__text">Add a task with a start time and ROUTIQ will show you what to do next.</p>
        <button type="button" class="btn btn--light" data-action="open-task-form">${icon('plus')}Add task</button>`;
      return;
    }
    if (!next) {
      el.innerHTML = `<p class="next-card__label" id="next-heading">All done</p>
        <h2 class="next-card__title">You finished everything on today's list</h2>
        <p class="next-card__text">${todays.length} of ${todays.length} tasks complete. Rest up, or add something else if you have energy left.</p>
        <button type="button" class="btn btn--secondary" data-action="open-task-form">${icon('plus')}Add another task</button>`;
      return;
    }
    const status = taskStatus(next);
    const label = status.key === 'overdue' ? 'Overdue' : status.key === 'active' ? 'Happening now' : 'Up next';
    el.innerHTML = `<p class="next-card__label" id="next-heading">${label}</p>
      <h2 class="next-card__title">${escapeHTML(next.title)}</h2>
      <p class="next-card__meta">
        <span>${icon('clock')}${formatTime(next.time)}</span>
        <span>${formatDuration(next.duration)}</span>
        <span>${escapeHTML(next.category)}</span>
        ${status.key === 'overdue' ? '<span class="next-card__flag">Past its scheduled time</span>' : ''}
      </p>
      <button type="button" class="btn btn--light" data-action="start-task" data-id="${escapeHTML(next.id)}">${icon('play')}Start task</button>`;
  }

  function renderDashboard() {
    renderHeader();
    renderOverview();
    renderNextTask();
    renderTaskList($('#dashboard-schedule'), tasksForDate(state.today), {
      title: 'No tasks scheduled today',
      text: 'Your schedule is clear. Add a task to plan your day.',
      actionHTML: addTaskButtonHTML(),
    });
    renderHabitList($('#dashboard-habits'), { compact: true });
  }

  function renderRoutine() {
    const date = state.routineDate;
    const s = dayStats(date);
    $('#routine-date').value = date;
    $('#routine-date-label').textContent = relativeDayLabel(date);
    $('#routine-summary').textContent = s.total ? `${s.done} of ${s.total} tasks done` : 'No tasks planned for this day';
    renderTaskList($('#routine-list'), tasksForDate(date), {
      title: 'Nothing planned for this day',
      text: 'Add tasks with a start time, duration, and category to build your routine.',
      actionHTML: addTaskButtonHTML(),
    });
  }

  function renderHabits() {
    const done = state.habits.filter((h) => h.history[state.today]).length;
    $('#habits-summary').textContent = state.habits.length
      ? `${done} of ${state.habits.length} habits done today`
      : 'Track daily habits and watch your streaks grow.';
    renderHabitList($('#habits-list'));
  }

  function renderFocusSelect() {
    const select = $('#focus-task');
    const previous = select.value;
    const options = tasksForDate(state.today).filter((t) => !t.completed || t.id === previous);
    select.innerHTML = '<option value="">No specific task</option>' +
      options.map((t) => `<option value="${escapeHTML(t.id)}">${escapeHTML(t.title)} (${formatTime(t.time)})</option>`).join('');
    select.value = options.some((t) => t.id === previous) ? previous : '';
  }

  function renderProgress() {
    const today = dayStats(state.today);
    $('#prog-today').textContent = today.done;
    $('#prog-today-sub').textContent = `of ${today.total} scheduled today`;
    $('#prog-percent').textContent = `${today.percent}%`;
    setBar('#prog-percent-bar', today.percent);

    const week = weekStats();
    $('#prog-week').textContent = week.percent === null ? '—' : `${week.percent}%`;
    $('#prog-week-sub').textContent = week.total ? `${week.done} of ${week.total} tasks in 7 days` : 'No tasks in the last 7 days';

    const habits = overallHabitConsistency();
    $('#prog-habits').textContent = habits.percent === null ? '—' : `${habits.percent}%`;
    $('#prog-habits-sub').textContent = habits.eligible ? `${habits.done} of ${habits.eligible} habit check-ins` : 'Add a habit to track consistency';

    renderWeekChart(week);
    renderHabitConsistency();
  }

  function renderWeekChart(week) {
    const max = Math.max(1, ...week.days.map((d) => d.total));
    const cols = week.days.map((d) => {
      const barHeight = (d.total / max) * 100;
      const fillHeight = d.total ? (d.done / d.total) * 100 : 0;
      const dayName = formatDateLabel(d.date, { weekday: 'short' });
      const fullLabel = formatDateLabel(d.date, { weekday: 'long', month: 'short', day: 'numeric' });
      return `<li class="chart__col ${d.date === state.today ? 'is-today' : ''}">
        <span class="sr-only">${fullLabel}: ${d.done} of ${d.total} tasks completed</span>
        <span class="chart__value" aria-hidden="true">${d.total ? `${d.done}/${d.total}` : '–'}</span>
        <div class="chart__track" aria-hidden="true">
          <div class="chart__bar" style="height:${barHeight}%"><span class="chart__fill" style="height:${fillHeight}%"></span></div>
        </div>
        <span class="chart__label" aria-hidden="true">${d.date === state.today ? 'Today' : dayName}</span>
      </li>`;
    }).join('');
    $('#week-chart').innerHTML = `<ol class="chart" aria-label="Tasks completed per day over the last 7 days">${cols}</ol>` +
      (week.total ? '' : '<p class="chart-note">No tasks were scheduled in the last 7 days, so there is nothing to chart yet.</p>');
  }

  function renderHabitConsistency() {
    const container = $('#habit-consistency');
    if (!state.habits.length) {
      container.innerHTML = emptyStateHTML({
        iconName: 'habits',
        title: 'No habits to measure',
        text: 'Add a habit and mark it complete each day to see your consistency.',
        actionHTML: '<a class="btn btn--secondary" href="#habits">Add a habit</a>',
      });
      return;
    }
    container.innerHTML = `<ul class="consistency">${state.habits.map((h) => {
      const w = habitWeek(h);
      const dots = w.days.map((d) =>
        `<span class="dot ${d.done ? 'is-on' : ''} ${d.eligible ? '' : 'is-na'}" title="${formatDateLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}"></span>`
      ).join('');
      return `<li class="consistency__row">
        <span class="consistency__name">${escapeHTML(h.name)}</span>
        <span class="dots" aria-hidden="true">${dots}</span>
        <span class="consistency__pct">${w.percent === null ? '—' : `${w.percent}%`}<span class="sr-only"> (${w.done} of ${w.eligible} days in the last week)</span></span>
      </li>`;
    }).join('')}</ul>`;
  }

  function renderSettings() {
    $$('input[name="theme"]').forEach((r) => { r.checked = r.value === state.settings.theme; });
    $$('input[name="timeFormat"]').forEach((r) => { r.checked = r.value === state.settings.timeFormat; });
    const nameInput = $('#setting-name');
    if (document.activeElement !== nameInput) nameInput.value = state.settings.name;
  }

  function statusSignature() {
    const statuses = state.tasks.filter((t) => t.date <= state.today).map((t) => `${t.id}:${taskStatus(t).key}`).join('|');
    return `${state.today}|${new Date().getHours()}|${statuses}`;
  }

  function renderAll() {
    // Keep keyboard focus on the same control after a list is re-rendered.
    const active = document.activeElement;
    const item = active && active.closest ? active.closest('[data-id]') : null;
    const container = active && active.closest ? active.closest('[id]') : null;
    const restore = item && container && active.dataset && active.dataset.action
      ? { containerId: container.id, itemId: item.dataset.id, action: active.dataset.action }
      : null;

    renderDashboard();
    renderRoutine();
    renderHabits();
    renderFocusSelect();
    updateTimerUI();
    renderProgress();
    renderSettings();
    state.lastSignature = statusSignature();

    if (restore) {
      const host = document.getElementById(restore.containerId);
      const target = host && host.querySelector(`[data-id="${CSS.escape(restore.itemId)}"] [data-action="${restore.action}"]`);
      if (target) target.focus({ preventScroll: true });
    }
  }

  /* ---------- Task actions & form ---------- */
  function toggleTask(id) {
    const task = findTask(id);
    if (!task) return;
    task.completed = !task.completed;
    saveTasks();
    renderAll();
    toast(task.completed ? 'Task marked complete' : 'Task marked incomplete');
  }

  async function deleteTask(id) {
    const task = findTask(id);
    if (!task) return;
    const ok = await confirmAction({
      title: 'Delete this task?',
      message: `"${task.title}" will be permanently removed.`,
    });
    if (!ok) return;
    state.tasks = state.tasks.filter((t) => t.id !== id);
    if (timer.taskId === id) timer.taskId = null;
    saveTasks();
    renderAll();
    toast('Task deleted');
  }

  function suggestedTime() {
    const minutes = Math.min(Math.ceil((nowMinutes() + 1) / 30) * 30, 23 * 60 + 30);
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }

  function clearFieldErrors(form) {
    $$('.field__error', form).forEach((p) => { p.textContent = ''; });
    $$('input', form).forEach((i) => i.removeAttribute('aria-invalid'));
  }

  function setFieldError(input, message) {
    const error = document.getElementById(`${input.id}-error`);
    if (error) error.textContent = message || '';
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function openTaskForm(taskId = null) {
    const form = $('#task-form');
    const editing = taskId ? findTask(taskId) : null;
    state.editingTaskId = editing ? editing.id : null;
    clearFieldErrors(form);

    $('#task-dialog-title').textContent = editing ? 'Edit task' : 'Add task';
    $('#task-submit').textContent = editing ? 'Save changes' : 'Add task';

    if (editing) {
      $('#task-title').value = editing.title;
      $('#task-date').value = editing.date;
      $('#task-time').value = editing.time;
      $('#task-duration').value = editing.duration;
      $('#task-category').value = editing.category;
    } else {
      const onRoutine = state.view === 'routine';
      $('#task-title').value = '';
      $('#task-date').value = onRoutine ? state.routineDate : state.today;
      $('#task-time').value = onRoutine && state.routineDate !== state.today ? '09:00' : suggestedTime();
      $('#task-duration').value = 30;
      $('#task-category').value = 'Personal';
    }
    $('#task-dialog').showModal();
    $('#task-title').focus();
  }

  function validateTaskForm() {
    const title = $('#task-title');
    const date = $('#task-date');
    const time = $('#task-time');
    const duration = $('#task-duration');
    let firstInvalid = null;
    const fail = (input, message) => {
      setFieldError(input, message);
      if (!firstInvalid) firstInvalid = input;
    };
    clearFieldErrors($('#task-form'));

    const titleValue = title.value.trim();
    if (!titleValue) fail(title, 'Enter a task title.');
    else if (titleValue.length > 80) fail(title, 'Keep the title to 80 characters or fewer.');

    if (!isValidDateKey(date.value)) fail(date, 'Choose a valid date.');
    if (!isValidTime(time.value)) fail(time, 'Choose a valid start time.');

    const minutes = Number(duration.value);
    if (duration.value.trim() === '' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TASK_MINUTES) {
      fail(duration, `Enter a whole number from 1 to ${MAX_TASK_MINUTES}.`);
    }

    if (firstInvalid) {
      firstInvalid.focus();
      return null;
    }
    return {
      title: titleValue,
      date: date.value,
      time: time.value,
      duration: minutes,
      category: CATEGORIES.includes($('#task-category').value) ? $('#task-category').value : 'Other',
    };
  }

  function handleTaskSubmit(event) {
    event.preventDefault();
    const values = validateTaskForm();
    if (!values) return;

    let message;
    if (state.editingTaskId) {
      const task = findTask(state.editingTaskId);
      if (task) Object.assign(task, values);
      message = 'Task updated';
    } else {
      state.tasks.push({ id: createId(), ...values, completed: false });
      message = values.date === state.today
        ? 'Task added'
        : `Task added for ${formatDateLabel(values.date, { month: 'short', day: 'numeric' })}`;
    }
    state.editingTaskId = null;
    saveTasks();
    $('#task-dialog').close();
    renderAll();
    toast(message);
  }

  /* ---------- Habit actions ---------- */
  function handleHabitSubmit(event) {
    event.preventDefault();
    const input = $('#habit-name');
    const name = input.value.trim();
    setFieldError(input, '');

    if (!name) return failHabit(input, 'Enter a habit name.');
    if (name.length > 60) return failHabit(input, 'Keep the name to 60 characters or fewer.');
    if (state.habits.some((h) => h.name.toLowerCase() === name.toLowerCase())) {
      return failHabit(input, 'You already track a habit with that name.');
    }
    state.habits.push({ id: createId(), name, createdOn: state.today, history: {} });
    saveHabits();
    input.value = '';
    renderAll();
    input.focus();
    toast('Habit added');
  }

  function failHabit(input, message) {
    setFieldError(input, message);
    input.focus();
  }

  function toggleHabit(id) {
    const habit = findHabit(id);
    if (!habit) return;
    if (habit.history[state.today]) delete habit.history[state.today];
    else habit.history[state.today] = true;
    saveHabits();
    renderAll();
    toast(habit.history[state.today] ? 'Habit done for today' : "Today's check-in undone");
  }

  async function deleteHabit(id) {
    const habit = findHabit(id);
    if (!habit) return;
    const ok = await confirmAction({
      title: 'Delete this habit?',
      message: `"${habit.name}" and its completion history will be permanently removed.`,
    });
    if (!ok) return;
    state.habits = state.habits.filter((h) => h.id !== id);
    saveHabits();
    renderAll();
    toast('Habit deleted');
  }

  /* ---------- Focus timer ---------- */
  const timer = {
    status: 'idle', // idle | running | paused | done
    totalMs: 25 * 60000,
    remainingMs: 25 * 60000,
    endAt: 0,
    intervalId: null,
    taskId: null,
  };

  function readFocusMinutes({ showError = false } = {}) {
    const input = $('#focus-duration');
    const value = Number(input.value);
    const valid = input.value.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= MAX_FOCUS_MINUTES;
    if (showError) setFieldError(input, valid ? '' : `Enter a whole number from 1 to ${MAX_FOCUS_MINUTES}.`);
    return valid ? value : null;
  }

  function clearTimerInterval() {
    if (timer.intervalId !== null) {
      clearInterval(timer.intervalId);
      timer.intervalId = null;
    }
  }

  function announce(message) {
    $('#timer-announce').textContent = message;
  }

  function syncIdleTimer() {
    const minutes = readFocusMinutes() ?? 25;
    timer.totalMs = minutes * 60000;
    timer.remainingMs = timer.totalMs;
  }

  function startTimer() {
    const minutes = readFocusMinutes({ showError: true });
    if (minutes === null) return;
    timer.totalMs = minutes * 60000;
    timer.remainingMs = timer.totalMs;
    timer.taskId = $('#focus-task').value || null;
    $('#focus-complete-wrap').hidden = true;
    runTimer();
    announce('Focus session started.');
  }

  function runTimer() {
    clearTimerInterval();
    timer.endAt = Date.now() + timer.remainingMs;
    timer.status = 'running';
    timer.intervalId = setInterval(tickTimer, 250);
    updateTimerUI();
  }

  function tickTimer() {
    if (timer.status !== 'running') return;
    // Derive remaining time from the wall clock so late or throttled ticks stay accurate.
    timer.remainingMs = Math.max(0, timer.endAt - Date.now());
    if (timer.remainingMs <= 0) finishTimer();
    else updateTimerUI();
  }

  function pauseTimer() {
    if (timer.status !== 'running') return;
    timer.remainingMs = Math.max(0, timer.endAt - Date.now());
    clearTimerInterval();
    timer.status = 'paused';
    updateTimerUI();
    announce('Timer paused.');
  }

  function resumeTimer() {
    if (timer.status !== 'paused') return;
    runTimer();
    announce('Timer resumed.');
  }

  function resetTimer() {
    clearTimerInterval();
    timer.status = 'idle';
    $('#focus-complete-wrap').hidden = true;
    syncIdleTimer();
    updateTimerUI();
    announce('Timer reset.');
  }

  function finishTimer() {
    clearTimerInterval();
    timer.status = 'done';
    timer.remainingMs = 0;
    updateTimerUI();
    const task = timer.taskId ? findTask(timer.taskId) : null;
    $('#focus-complete-wrap').hidden = false;
    $('#focus-complete-task').hidden = !(task && !task.completed);
    announce('Focus session complete.');
    toast('Focus session complete');
  }

  function updateTimerUI() {
    const status = timer.status;
    const remaining = status === 'running' ? Math.max(0, timer.endAt - Date.now()) : timer.remainingMs;
    const display = formatClock(remaining);
    const fraction = timer.totalMs ? remaining / timer.totalMs : 1;

    $('#timer-display').textContent = display;
    $('#timer-ring').style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
    $('#timer-state').textContent = { idle: 'Ready', running: 'Focusing', paused: 'Paused', done: 'Complete' }[status];

    const active = status === 'running' || status === 'paused';
    $('#timer-start').hidden = active;
    $('#timer-start span').textContent = status === 'done' ? 'Start again' : 'Start';
    $('#timer-pause').hidden = status !== 'running';
    $('#timer-resume').hidden = status !== 'paused';
    $('#timer-reset').hidden = status === 'idle';
    $('#focus-setup').disabled = active;

    const task = timer.taskId && active || status === 'done' ? findTask(timer.taskId) : findTask($('#focus-task').value);
    $('#focus-task-label').textContent = task ? task.title : 'Focus session';
    document.title = status === 'running'
      ? `${display} · ROUTIQ`
      : `${VIEWS[state.view]} · ROUTIQ`;
  }

  function startTaskInFocus(taskId) {
    const task = findTask(taskId);
    if (!task) return;
    const begin = () => {
      resetTimer();
      renderFocusSelect();
      $('#focus-task').value = task.id;
      $('#focus-duration').value = Math.min(task.duration, MAX_FOCUS_MINUTES);
      syncIdleTimer();
      location.hash = '#focus';
      startTimer();
    };
    if (timer.status === 'running' || timer.status === 'paused') {
      confirmAction({
        title: 'Replace current focus session?',
        message: 'A focus session is in progress. Starting this task will reset the timer.',
        confirmLabel: 'Start new session',
      }).then((ok) => { if (ok) begin(); });
    } else {
      begin();
    }
  }

  function completeTimerTask() {
    const task = timer.taskId ? findTask(timer.taskId) : null;
    if (!task) return;
    task.completed = true;
    saveTasks();
    $('#focus-complete-task').hidden = true;
    renderAll();
    toast('Task marked complete');
  }

  /* ---------- Settings ---------- */
  const systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function applyTheme() {
    const pref = state.settings.theme;
    const resolved = pref === 'system' ? (systemDark && systemDark.matches ? 'dark' : 'light') : pref;
    document.documentElement.dataset.theme = resolved;
  }

  async function clearAllData() {
    const ok = await confirmAction({
      title: 'Clear all ROUTIQ data?',
      message: 'This permanently deletes every task, habit, completion record, and setting stored in this browser. This cannot be undone.',
      confirmLabel: 'Clear all data',
    });
    if (!ok) return;
    clearTimerInterval();
    Object.values(STORAGE_KEYS).forEach((key) => {
      try { localStorage.removeItem(key); } catch (_) { /* storage unavailable */ }
    });
    state.tasks = [];
    state.habits = [];
    state.settings = { ...DEFAULT_SETTINGS };
    state.routineDate = state.today;
    timer.status = 'idle';
    timer.taskId = null;
    $('#focus-duration').value = 25;
    $('#focus-complete-wrap').hidden = true;
    syncIdleTimer();
    applyTheme();
    renderAll();
    toast('All data cleared');
  }

  /* ---------- Navigation ---------- */
  function showView(view, { moveFocus = false } = {}) {
    state.view = view;
    $$('.view').forEach((section) => { section.hidden = section.dataset.view !== view; });
    $$('.nav__link').forEach((link) => {
      if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    closeDrawer({ restoreFocus: false });
    window.scrollTo(0, 0);
    updateTimerUI();
    if (moveFocus) {
      const heading = $(`#view-${view} h1`);
      if (heading) heading.focus({ preventScroll: true });
    }
  }

  function route({ moveFocus = false } = {}) {
    const hash = location.hash.replace('#', '');
    showView(Object.prototype.hasOwnProperty.call(VIEWS, hash) ? hash : 'dashboard', { moveFocus });
  }

  let drawerReturnFocus = null;
  const isDrawerOpen = () => $('#sidebar').classList.contains('is-open');

  function openDrawer() {
    drawerReturnFocus = document.activeElement;
    $('#sidebar').classList.add('is-open');
    $('#scrim').hidden = false;
    $('#menu-button').setAttribute('aria-expanded', 'true');
    const current = $('.nav__link[aria-current="page"]') || $('.nav__link');
    current.focus();
  }

  function closeDrawer({ restoreFocus = true } = {}) {
    if (!isDrawerOpen()) return;
    $('#sidebar').classList.remove('is-open');
    $('#scrim').hidden = true;
    $('#menu-button').setAttribute('aria-expanded', 'false');
    if (restoreFocus && drawerReturnFocus && document.contains(drawerReturnFocus)) drawerReturnFocus.focus();
    drawerReturnFocus = null;
  }

  function shiftRoutineDate(days) {
    state.routineDate = addDays(state.routineDate, days);
    renderRoutine();
  }

  /* ---------- Events ---------- */
  function handleClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const id = (el.closest('[data-id]') || el).dataset.id;

    switch (el.dataset.action) {
      case 'open-nav': openDrawer(); break;
      case 'close-nav': closeDrawer(); break;
      case 'open-task-form': openTaskForm(); break;
      case 'close-dialog': el.closest('dialog').close(); break;
      case 'toggle-task': toggleTask(id); break;
      case 'edit-task': openTaskForm(id); break;
      case 'delete-task': deleteTask(id); break;
      case 'start-task': startTaskInFocus(id); break;
      case 'toggle-habit': toggleHabit(id); break;
      case 'delete-habit': deleteHabit(id); break;
      case 'routine-prev': shiftRoutineDate(-1); break;
      case 'routine-next': shiftRoutineDate(1); break;
      case 'routine-today': state.routineDate = state.today; renderRoutine(); break;
      case 'timer-start': startTimer(); break;
      case 'timer-pause': pauseTimer(); break;
      case 'timer-resume': resumeTimer(); break;
      case 'timer-reset': resetTimer(); break;
      case 'timer-complete-task': completeTimerTask(); break;
      case 'focus-preset':
        $('#focus-duration').value = el.dataset.minutes;
        setFieldError($('#focus-duration'), '');
        if (timer.status === 'idle' || timer.status === 'done') {
          timer.status = 'idle';
          syncIdleTimer();
          updateTimerUI();
        }
        break;
      case 'clear-data': clearAllData(); break;
      default: break;
    }
  }

  function bindEvents() {
    document.addEventListener('click', handleClick);

    // Dialogs: close when the backdrop is clicked.
    $$('dialog').forEach((dialog) => {
      dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close('cancel'); });
    });

    $('#task-form').addEventListener('submit', handleTaskSubmit);
    $('#habit-form').addEventListener('submit', handleHabitSubmit);

    $('#routine-date').addEventListener('change', (e) => {
      if (isValidDateKey(e.target.value)) {
        state.routineDate = e.target.value;
        renderRoutine();
      }
    });

    // Focus setup
    $('#focus-task').addEventListener('change', (e) => {
      const task = findTask(e.target.value);
      if (task) {
        $('#focus-duration').value = Math.min(task.duration, MAX_FOCUS_MINUTES);
        setFieldError($('#focus-duration'), '');
      }
      if (timer.status !== 'running' && timer.status !== 'paused') {
        timer.status = 'idle';
        syncIdleTimer();
        updateTimerUI();
      }
    });
    $('#focus-duration').addEventListener('input', () => {
      if (timer.status === 'running' || timer.status === 'paused') return;
      timer.status = 'idle';
      if (readFocusMinutes() !== null) setFieldError($('#focus-duration'), '');
      syncIdleTimer();
      updateTimerUI();
    });

    // Settings
    $$('input[name="theme"]').forEach((r) => r.addEventListener('change', () => {
      state.settings.theme = r.value;
      saveSettings();
      applyTheme();
    }));
    $$('input[name="timeFormat"]').forEach((r) => r.addEventListener('change', () => {
      state.settings.timeFormat = r.value;
      saveSettings();
      renderAll();
    }));
    $('#setting-name').addEventListener('input', (e) => {
      state.settings.name = e.target.value.trim().slice(0, 40);
      saveSettings();
      renderHeader();
    });

    if (systemDark) {
      const onChange = () => { if (state.settings.theme === 'system') applyTheme(); };
      if (systemDark.addEventListener) systemDark.addEventListener('change', onChange);
    }

    // Navigation
    window.addEventListener('hashchange', () => route({ moveFocus: true }));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isDrawerOpen()) closeDrawer();
    });
    window.matchMedia('(min-width: 900px)').addEventListener('change', (e) => { if (e.matches) closeDrawer({ restoreFocus: false }); });

    // Changes made in another tab
    window.addEventListener('storage', (e) => {
      if (!Object.values(STORAGE_KEYS).includes(e.key) && e.key !== null) return;
      loadAll();
      applyTheme();
      renderAll();
    });

    // Day rollover and status refresh
    setInterval(checkClock, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkClock();
        tickTimer();
      }
    });
    window.addEventListener('focus', checkClock);
    window.addEventListener('beforeunload', clearTimerInterval);
  }

  function checkClock() {
    const key = toDateKey();
    if (key !== state.today) {
      const followingToday = state.routineDate === state.today;
      state.today = key;
      if (followingToday) state.routineDate = key;
      renderAll();
      toast('A new day has started');
    } else if (statusSignature() !== state.lastSignature) {
      renderAll();
    }
  }

  /* ---------- Init ---------- */
  function init() {
    state.storageOk = storageAvailable();
    loadAll();
    state.today = toDateKey();
    state.routineDate = state.today;

    $('#task-category').innerHTML = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');

    applyTheme();
    syncIdleTimer();
    bindEvents();
    route();
    renderAll();

    if (!state.storageOk) {
      toast('Browser storage is unavailable, so your data will not be saved after you leave.', 'error');
    }
  }

  init();
})();
