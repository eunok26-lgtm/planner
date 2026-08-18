/* ============================================================
   플래너 — 구글 캘린더 / 구글 Tasks 연동

   설계 원칙 : 저장소는 한 곳(구글)뿐이고 월간·위클리·오늘 화면은
   모두 같은 store 를 읽어서 그립니다. 그래서 어느 화면에서 고쳐도
   나머지 화면이 저절로 같은 값을 보여줍니다.
   ============================================================ */

const CFG = window.APP_CONFIG;

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks'
].join(' ');

const CAL_BASE  = 'https://www.googleapis.com/calendar/v3/calendars/' +
                  encodeURIComponent(CFG.CALENDAR_ID) + '/events';
const TASK_BASE = 'https://tasks.googleapis.com/tasks/v1';

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ============================================================
   1. 인증
   ============================================================ */
let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

function waitForGsi() {
  return new Promise((resolve, reject) => {
    let n = 0;
    (function poll() {
      if (window.google?.accounts?.oauth2) return resolve();
      if (++n > 100) return reject(new Error('gsi_load_failed'));
      setTimeout(poll, 100);
    })();
  });
}

async function initAuth() {
  await waitForGsi();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: () => {}
  });
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    tokenClient.callback = resp => {
      if (resp.error) return reject(new Error(resp.error));
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
      localStorage.setItem('planner.consented', '1');
      resolve(accessToken);
    };
    tokenClient.error_callback = err => reject(new Error(err?.type || 'oauth_error'));
    tokenClient.requestAccessToken({ prompt });
  });
}

async function ensureToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  return requestToken('');
}

async function api(url, opts = {}, retried = false) {
  const token = await ensureToken();
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (res.status === 401 && !retried) {
    accessToken = null;
    return api(url, opts, true);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ============================================================
   2. 데이터 저장소 (모든 화면의 단일 출처)
   ============================================================ */
const store = {
  events: new Map(),      // 'YYYY-MM-DD' → [event]
  loadedMonths: new Set(),// 'YYYY-MM'
  todo: [],
  shop: [],
  lists: JSON.parse(localStorage.getItem('planner.lists') || 'null') || {}
};

/* 오프라인에서도 마지막 화면이 보이도록 캐시 */
function saveCache() {
  try {
    localStorage.setItem('planner.cache', JSON.stringify({
      events: [...store.events], todo: store.todo, shop: store.shop, at: Date.now()
    }));
  } catch (e) { /* 용량 초과는 무시 */ }
}
function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem('planner.cache') || 'null');
    if (!c) return;
    store.events = new Map(c.events);
    store.todo = c.todo || [];
    store.shop = c.shop || [];
  } catch (e) {}
}

const monthKey = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1);

/** 구글 일정 → 앱 내부 형식. 여러 날짜에 걸친 종일 일정은 날짜별로 펼칩니다. */
function normalizeEvent(g) {
  const allDay = !!g.start?.date;
  const rows = [];
  if (allDay) {
    const from = parseYmd(g.start.date);
    const to   = parseYmd(g.end.date);              // end 는 제외 경계
    for (let d = new Date(from); d < to; d = addDays(d, 1)) {
      rows.push({ id: g.id, date: ymd(d), allDay: true, time: null,
                  text: g.summary || '(제목 없음)', note: g.description || '',
                  startDate: g.start.date, endDate: g.end.date });
    }
    if (!rows.length) {
      rows.push({ id: g.id, date: g.start.date, allDay: true, time: null,
                  text: g.summary || '(제목 없음)', note: g.description || '',
                  startDate: g.start.date, endDate: g.end.date });
    }
  } else {
    const s = new Date(g.start.dateTime);
    rows.push({ id: g.id, date: ymd(s), allDay: false,
                time: pad2(s.getHours()) + ':' + pad2(s.getMinutes()),
                text: g.summary || '(제목 없음)', note: g.description || '',
                startISO: g.start.dateTime, endISO: g.end?.dateTime });
  }
  return rows;
}

function indexEvents(list, fromKey, toKey) {
  // 해당 구간의 기존 항목을 비우고 새로 채웁니다 (삭제 반영을 위해)
  for (const k of [...store.events.keys()]) {
    if (k >= fromKey && k <= toKey) store.events.delete(k);
  }
  for (const g of list) {
    for (const ev of normalizeEvent(g)) {
      if (ev.date < fromKey || ev.date > toKey) continue;
      if (!store.events.has(ev.date)) store.events.set(ev.date, []);
      store.events.get(ev.date).push(ev);
    }
  }
  for (const arr of store.events.values()) {
    arr.sort((a, b) => (a.allDay === b.allDay)
      ? (a.time || '').localeCompare(b.time || '') || a.text.localeCompare(b.text)
      : (a.allDay ? -1 : 1));
  }
}

/** 한 달치(앞뒤 여유 7일 포함) 일정을 불러옵니다. */
async function loadMonth(anchor, force = false) {
  const mk = monthKey(anchor);
  if (!force && store.loadedMonths.has(mk)) return;
  const from = addDays(new Date(anchor.getFullYear(), anchor.getMonth(), 1), -7);
  const to   = addDays(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1), 7);
  const qs = new URLSearchParams({
    timeMin: from.toISOString(), timeMax: to.toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '2500'
  });
  const j = await api(`${CAL_BASE}?${qs}`);
  indexEvents(j.items || [], ymd(from), ymd(addDays(to, -1)));
  store.loadedMonths.add(mk);
  saveCache();
}

const eventsOn = dateStr => store.events.get(dateStr) || [];

/* ---------------- 일정 쓰기 ---------------- */
function eventBody(f) {
  const body = { summary: f.text, description: f.note || '' };
  if (f.allDay) {
    body.start = { date: f.date };
    body.end   = { date: ymd(addDays(parseYmd(f.date), 1)) };
  } else {
    const [h, m] = (f.time || '09:00').split(':').map(Number);
    const s = parseYmd(f.date); s.setHours(h, m, 0, 0);
    const e = new Date(s.getTime() + 60 * 60 * 1000);
    body.start = { dateTime: s.toISOString() };
    body.end   = { dateTime: e.toISOString() };
  }
  return body;
}

async function createEvent(f) {
  await api(CAL_BASE, { method: 'POST', body: JSON.stringify(eventBody(f)) });
  await refreshAround(parseYmd(f.date));
}
async function updateEvent(id, f) {
  // PATCH 는 건드리지 않은 필드(참석자·알림 등)를 그대로 보존합니다
  await api(`${CAL_BASE}/${encodeURIComponent(id)}`,
            { method: 'PATCH', body: JSON.stringify(eventBody(f)) });
  await refreshAround(parseYmd(f.date));
}
async function deleteEvent(id, dateStr) {
  await api(`${CAL_BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refreshAround(parseYmd(dateStr));
}

/** 바뀐 날짜가 속한 달(과 인접 달)을 다시 불러와 모든 화면을 맞춥니다. */
async function refreshAround(d) {
  const months = new Set([monthKey(d), monthKey(state.anchor)]);
  for (const mk of months) {
    const [y, m] = mk.split('-').map(Number);
    await loadMonth(new Date(y, m - 1, 1), true);
  }
}

/* ============================================================
   3. 구글 Tasks (할 일 · 쇼핑)
   ============================================================ */
async function ensureLists() {
  if (store.lists.todo && store.lists.shop) return store.lists;
  const j = await api(`${TASK_BASE}/users/@me/lists?maxResults=100`);
  const items = j.items || [];
  const find = title => items.find(x => x.title === title);

  async function getOrCreate(title) {
    const hit = find(title);
    if (hit) return hit.id;
    const made = await api(`${TASK_BASE}/users/@me/lists`,
                           { method: 'POST', body: JSON.stringify({ title }) });
    return made.id;
  }
  store.lists = {
    todo: await getOrCreate(CFG.TASKLIST_TODO),
    shop: await getOrCreate(CFG.TASKLIST_SHOPPING)
  };
  localStorage.setItem('planner.lists', JSON.stringify(store.lists));
  return store.lists;
}

async function loadTasks() {
  const l = await ensureLists();
  const q = 'showCompleted=true&showHidden=true&maxResults=100';
  const [a, b] = await Promise.all([
    api(`${TASK_BASE}/lists/${l.todo}/tasks?${q}`),
    api(`${TASK_BASE}/lists/${l.shop}/tasks?${q}`)
  ]);
  const map = t => ({ id: t.id, title: t.title || '', done: t.status === 'completed',
                      notes: t.notes || '', pos: t.position || '' });
  store.todo = (a.items || []).map(map).filter(t => t.title);
  store.shop = (b.items || []).map(map).filter(t => t.title);
  saveCache();
}

async function addTask(which, title, notes) {
  const l = await ensureLists();
  await api(`${TASK_BASE}/lists/${l[which]}/tasks`,
            { method: 'POST', body: JSON.stringify({ title, notes: notes || '' }) });
  await loadTasks();
}
async function toggleTask(which, task) {
  const l = await ensureLists();
  const body = task.done
    ? { status: 'needsAction', completed: null }
    : { status: 'completed' };
  await api(`${TASK_BASE}/lists/${l[which]}/tasks/${task.id}`,
            { method: 'PATCH', body: JSON.stringify(body) });
  await loadTasks();
}
async function removeTask(which, id) {
  const l = await ensureLists();
  await api(`${TASK_BASE}/lists/${l[which]}/tasks/${id}`, { method: 'DELETE' });
  await loadTasks();
}

/* ============================================================
   4. 화면 상태
   ============================================================ */
const state = { view: 'month', anchor: new Date() };

const MONTH_TITLE = d => d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월';

function setSync(text, cls = '') {
  const el = $('#sync');
  el.textContent = text;
  el.className = 'sync ' + cls;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

async function guard(fn, busyMsg = '동기화 중…') {
  try {
    setSync(busyMsg, 'busy');
    await fn();
    setSync('');
  } catch (e) {
    console.error(e);
    setSync('연결 실패', 'err');
    toast(navigator.onLine ? '구글 연결에 실패했습니다' : '오프라인 — 저장된 내용을 보는 중');
  }
}

/* ============================================================
   5. 월간
   ============================================================ */
function renderMonth() {
  const a = state.anchor;
  $('#title').textContent = MONTH_TITLE(a);
  $('#subtitle').textContent = '';

  const dowHead = $('#month-dow');
  if (!dowHead.childElementCount) {
    const order = CFG.WEEK_START === 1 ? [1,2,3,4,5,6,0] : [0,1,2,3,4,5,6];
    dowHead.innerHTML = order.map(i =>
      `<div class="${i===0?'sun':i===6?'sat':''}">${DOW_KR[i]}</div>`).join('');
  }

  const first = new Date(a.getFullYear(), a.getMonth(), 1);
  const gridStart = startOfWeek(first, CFG.WEEK_START);
  const today = new Date();

  // 이 달을 덮는 데 필요한 줄 수만 그립니다 (5줄이면 5줄, 6줄이면 6줄)
  const daysInMonth = new Date(a.getFullYear(), a.getMonth() + 1, 0).getDate();
  const lead = Math.round((first - gridStart) / 86400000);
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;

  let html = '';
  for (let i = 0; i < cells; i++) {
    const d = addDays(gridStart, i);
    const ds = ymd(d);
    const kind = dayKind(d);
    const label = holidayOf(d) || termOf(d) || '';
    const evs = eventsOn(ds);
    const shown = evs.slice(0, 3).map(e =>
      `<span class="pill ${e.allDay ? '' : 'timed'}" data-id="${e.id}" data-date="${ds}"
             ${e.time ? `data-t="${e.time}"` : ''}>${esc(e.text)}</span>`).join('');

    html += `<div class="mcell ${kind} ${d.getMonth() !== a.getMonth() ? 'other' : ''}
                        ${sameDay(d, today) ? 'is-today' : ''}" data-date="${ds}">
        <div class="dn">${d.getDate()}</div>
        ${label ? `<div class="dt">${esc(label)}</div>` : ''}
        <div class="evs">${shown}${evs.length > 3 ? `<span class="more">+${evs.length - 3}</span>` : ''}</div>
      </div>`;
  }
  $('#month-grid').innerHTML = html;
}

/* ============================================================
   6. 위클리 (인쇄본과 같은 구성)
   ============================================================ */
const LINES = 7;

function renderWeek() {
  const mon = startOfWeek(state.anchor, CFG.WEEK_START);
  const sun = addDays(mon, 6);
  $('#title').textContent =
    `${mon.getMonth() + 1}.${pad2(mon.getDate())} – ${sun.getMonth() + 1}.${pad2(sun.getDate())}`;
  $('#subtitle').textContent = mon.getFullYear() + '년';

  const today = new Date();
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const ds = ymd(d);
    const label = holidayOf(d) || termOf(d) || '';
    const evs = eventsOn(ds);

    let lines = '';
    for (let k = 0; k < Math.max(LINES, evs.length); k++) {
      const e = evs[k];
      lines += e
        ? `<button class="wline" data-id="${e.id}" data-date="${ds}">
             ${e.time ? `<span class="wt">${e.time}</span>` : ''}
             <span class="wx">${esc(e.text)}</span></button>`
        : `<button class="wline empty" data-date="${ds}"></button>`;
    }

    html += `<div class="wcol ${dayKind(d)} ${sameDay(d, today) ? 'is-today' : ''}">
        <div class="wh">
          <div class="wdow">${DOW_KR[d.getDay()]}</div>
          <div class="wrow"><span class="wnum">${d.getDate()}</span>
            <span class="wtag">${esc(label)}</span></div>
        </div>
        ${lines}
      </div>`;
  }
  $('#week-grid').innerHTML = html;
}

/* ============================================================
   7. 오늘
   ============================================================ */
function renderToday() {
  const d = new Date();
  const ds = ymd(d);
  const hol = holidayOf(d), term = termOf(d);
  $('#title').textContent = '오늘';
  $('#subtitle').textContent = '';

  $('#today-head').className = 'today-head ' + (hol ? 'hol' : '');
  $('#today-head').innerHTML =
    `<div class="big">${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_KR[d.getDay()]})</div>
     <div class="sm">${esc(hol || term || '')}</div>`;

  const evs = eventsOn(ds);
  $('#today-events').innerHTML = evs.length
    ? evs.map(e => `<button class="ev" data-id="${e.id}" data-date="${ds}">
         <span class="t">${e.allDay ? '종일' : e.time}</span>
         <span class="x">${esc(e.text)}</span></button>`).join('')
    : '<div class="empty-note">오늘 등록된 일정이 없습니다.</div>';

  const sorted = [...store.todo].sort((a, b) => a.done - b.done);
  $('#todo-list').innerHTML = sorted.length
    ? sorted.map(t => taskRow('todo', t)).join('')
    : '<div class="empty-note">할 일이 없습니다.</div>';
}

function taskRow(which, t) {
  return `<div class="task ${t.done ? 'done' : ''}" data-list="${which}" data-id="${t.id}">
      <button class="box" data-act="toggle">✓</button>
      <span class="lbl">${esc(t.title)}</span>
      <button class="del" data-act="del" aria-label="삭제">×</button>
    </div>`;
}

/* ============================================================
   8. 쇼핑
   ============================================================ */
function renderShop() {
  $('#title').textContent = '쇼핑 리스트';
  $('#subtitle').textContent = '';

  const sel = $('#shop-cat');
  if (!sel.childElementCount) {
    sel.innerHTML = CFG.SHOP_CATEGORIES.map(c => `<option>${esc(c)}</option>`).join('');
  }

  const cats = [...CFG.SHOP_CATEGORIES];
  const groups = new Map(cats.map(c => [c, []]));
  for (const t of store.shop) {
    const c = groups.has(t.notes) ? t.notes : cats[cats.length - 1];
    groups.get(c).push(t);
  }

  let html = '';
  for (const [cat, items] of groups) {
    if (!items.length) continue;
    items.sort((a, b) => a.done - b.done);
    html += `<div><div class="shop-cat-h">${esc(cat)} · ${items.filter(i => !i.done).length}</div>
        <div class="task-list">${items.map(t => taskRow('shop', t)).join('')}</div></div>`;
  }
  $('#shop-list').innerHTML = html || '<div class="empty-note">담아둔 항목이 없습니다.</div>';
}

/* ============================================================
   9. 일정 편집 시트
   ============================================================ */
let editing = null;   // { id, date } | null

function openSheet(dateStr, id) {
  const evs = eventsOn(dateStr);
  const ev = id ? evs.find(e => e.id === id) : null;
  editing = ev ? { id: ev.id, date: dateStr } : null;

  $('#ev-title').textContent = ev ? '일정 수정' : '새 일정';
  $('#ev-text').value  = ev ? ev.text : '';
  $('#ev-date').value  = dateStr;
  $('#ev-note').value  = ev ? ev.note : '';
  $('#ev-allday').checked = ev ? ev.allDay : true;
  $('#ev-time').value  = ev && ev.time ? ev.time : '09:00';
  $('#ev-time').disabled = $('#ev-allday').checked;
  $('#ev-delete').hidden = !ev;

  $('#sheet').hidden = false;
  setTimeout(() => $('#ev-text').focus(), 60);
}
function closeSheet() { $('#sheet').hidden = true; editing = null; }

async function saveSheet() {
  const f = {
    text: $('#ev-text').value.trim(),
    date: $('#ev-date').value,
    time: $('#ev-time').value,
    allDay: $('#ev-allday').checked,
    note: $('#ev-note').value.trim()
  };
  if (!f.text) { toast('내용을 입력해 주세요'); return; }
  if (!f.date) { toast('날짜를 선택해 주세요'); return; }

  closeSheet();
  await guard(async () => {
    if (editing) await updateEvent(editing.id, f);
    else         await createEvent(f);
    renderAll();
    toast('저장했습니다');
  }, '저장 중…');
}

/* ============================================================
   10. 렌더 · 이벤트 연결
   ============================================================ */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAll() {
  if (state.view === 'month') renderMonth();
  else if (state.view === 'week') renderWeek();
  else if (state.view === 'today') renderToday();
  else renderShop();
}

function showView(v) {
  state.view = v;
  $$('.tab').forEach(t => t.classList.toggle('is-on', t.dataset.view === v));
  ['month', 'week', 'today', 'shop'].forEach(k => { $('#view-' + k).hidden = (k !== v); });
  $('#print-btn').hidden = (v !== 'week');
  $('#prev').style.visibility = $('#next').style.visibility =
    (v === 'month' || v === 'week') ? 'visible' : 'hidden';
  $('#today-btn').style.visibility = (v === 'month' || v === 'week') ? 'visible' : 'hidden';
  renderAll();
  syncCurrentView();
}

/** 지금 보고 있는 화면에 필요한 데이터를 확보합니다. */
function syncCurrentView() {
  guard(async () => {
    if (state.view === 'month' || state.view === 'week') {
      await loadMonth(state.anchor);
      if (state.view === 'week') {
        const mon = startOfWeek(state.anchor, CFG.WEEK_START);
        const sun = addDays(mon, 6);
        if (mon.getMonth() !== sun.getMonth()) await loadMonth(sun);
      }
    } else if (state.view === 'today') {
      await loadMonth(new Date());
      await loadTasks();
    } else {
      await loadTasks();
    }
    renderAll();
  });
}

function shift(dir) {
  if (state.view === 'month') {
    state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + dir, 1);
  } else if (state.view === 'week') {
    state.anchor = addDays(state.anchor, dir * 7);
  }
  renderAll();
  syncCurrentView();
}

/** 인쇄용 타공 표시 — ⌀4mm · 피치 10mm · 230mm 폭 중앙 정렬 (종이 양식과 동일) */
function buildPrintBinding() {
  let h = '<div class="pb"></div>';
  for (let x = 10; x <= 220; x += 10) h += `<div class="ph" style="left:${x}mm"></div>`;
  $('#print-binding').innerHTML = h;
}

function wire() {
  buildPrintBinding();
  $('#prev').onclick = () => shift(-1);
  $('#next').onclick = () => shift(1);
  $('#today-btn').onclick = () => { state.anchor = new Date(); renderAll(); syncCurrentView(); };
  $('#print-btn').onclick = () => window.print();
  $$('.tab').forEach(t => t.onclick = () => showView(t.dataset.view));

  $('#signout').onclick = () => {
    if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null; tokenExpiry = 0;
    localStorage.removeItem('planner.consented');
    localStorage.removeItem('planner.lists');
    location.reload();
  };

  /* 월간 — 칸/일정 클릭 */
  $('#month-grid').onclick = e => {
    const pill = e.target.closest('.pill');
    if (pill) return openSheet(pill.dataset.date, pill.dataset.id);
    const cell = e.target.closest('.mcell');
    if (cell) openSheet(cell.dataset.date, null);
  };

  /* 위클리 — 줄 클릭 */
  $('#week-grid').onclick = e => {
    const line = e.target.closest('.wline');
    if (line) openSheet(line.dataset.date, line.dataset.id || null);
  };

  /* 오늘 — 일정 클릭 */
  $('#today-events').onclick = e => {
    const b = e.target.closest('.ev');
    if (b) openSheet(b.dataset.date, b.dataset.id);
  };

  /* 할 일 · 쇼핑 공통 */
  function taskHandler(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('.task');
    const which = row.dataset.list;
    const id = row.dataset.id;
    const t = (which === 'todo' ? store.todo : store.shop).find(x => x.id === id);
    if (!t) return;
    if (btn.dataset.act === 'toggle') {
      guard(async () => { await toggleTask(which, t); renderAll(); }, '반영 중…');
    } else {
      guard(async () => { await removeTask(which, id); renderAll(); }, '삭제 중…');
    }
  }
  $('#todo-list').onclick = taskHandler;
  $('#shop-list').onclick = taskHandler;

  $('#add-todo').onclick = () => {
    const v = prompt('할 일을 입력하세요');
    if (v && v.trim()) guard(async () => { await addTask('todo', v.trim()); renderAll(); }, '추가 중…');
  };

  const addShop = () => {
    const v = $('#shop-input').value.trim();
    if (!v) return;
    const cat = $('#shop-cat').value;
    $('#shop-input').value = '';
    guard(async () => { await addTask('shop', v, cat); renderAll(); }, '추가 중…');
  };
  $('#shop-add-btn').onclick = addShop;
  $('#shop-input').onkeydown = e => { if (e.key === 'Enter') addShop(); };

  $('#shop-clear').onclick = () => {
    const done = store.shop.filter(t => t.done);
    if (!done.length) return toast('완료된 항목이 없습니다');
    if (!confirm(`완료된 ${done.length}개를 지울까요?`)) return;
    guard(async () => {
      for (const t of done) await removeTask('shop', t.id);
      renderAll();
    }, '정리 중…');
  };

  /* 편집 시트 */
  $('#ev-cancel').onclick = closeSheet;
  $('#ev-save').onclick   = saveSheet;
  $('#ev-allday').onchange = e => { $('#ev-time').disabled = e.target.checked; };
  $('#ev-delete').onclick = () => {
    if (!editing || !confirm('이 일정을 삭제할까요?')) return;
    const { id, date } = editing;
    closeSheet();
    guard(async () => { await deleteEvent(id, date); renderAll(); toast('삭제했습니다'); }, '삭제 중…');
  };
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };
  $('#ev-text').onkeydown = e => { if (e.key === 'Enter') saveSheet(); };

  /* 다른 기기에서 바꾼 내용 반영 — 앱으로 돌아올 때 새로고침 */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && accessToken) {
      store.loadedMonths.clear();
      syncCurrentView();
    }
  });
  window.addEventListener('online', () => syncCurrentView());
}

/* ============================================================
   11. 시작
   ============================================================ */
async function start() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
  showView('month');
}

async function boot() {
  loadCache();
  wire();

  if (!CFG.GOOGLE_CLIENT_ID || CFG.GOOGLE_CLIENT_ID.startsWith('여기에')) {
    $('#gate-msg').textContent =
      'config.js 에 구글 OAuth 클라이언트 ID 를 아직 넣지 않았습니다.\n' +
      '같은 폴더의 "설정가이드.md" 를 따라 발급받은 뒤 붙여넣어 주세요.';
    $('#signin').disabled = true;
    return;
  }

  try { await initAuth(); }
  catch (e) {
    $('#gate-msg').textContent = '구글 로그인 스크립트를 불러오지 못했습니다. 네트워크를 확인해 주세요.';
    return;
  }

  $('#signin').onclick = async () => {
    $('#gate-msg').textContent = '';
    try { await requestToken('consent'); await start(); }
    catch (e) { $('#gate-msg').textContent = '로그인이 취소되었거나 실패했습니다. (' + e.message + ')'; }
  };

  /* 이미 동의한 적이 있으면 조용히 다시 로그인 */
  if (localStorage.getItem('planner.consented')) {
    try { await requestToken(''); await start(); } catch (e) { /* 게이트 유지 */ }
  }
}

boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('sw.js').catch(() => {}));
}
