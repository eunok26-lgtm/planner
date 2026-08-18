/* ============================================================
   플래너 — 구글 캘린더 / 구글 Tasks 연동

   설계 원칙 : 저장소는 한 곳(구글)뿐이고 월간·위클리·오늘 화면은
   모두 같은 store 를 읽어서 그립니다. 그래서 어느 화면에서 고쳐도
   나머지 화면이 저절로 같은 값을 보여줍니다.
   ============================================================ */

const CFG = window.APP_CONFIG;

/* 위클리 전용 캘린더를 새로 만들어야 해서 캘린더 관리 권한이 필요합니다.
   (예전 calendar.events 권한만으로는 캘린더를 만들 수 없습니다) */
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks'
].join(' ');

const CAL_API   = 'https://www.googleapis.com/calendar/v3';
const TASK_BASE = 'https://tasks.googleapis.com/tasks/v1';

/** 캘린더별 일정 주소 */
const calBase = calId => `${CAL_API}/calendars/${encodeURIComponent(calId)}/events`;

let CAL_M = CFG.CALENDAR_ID;                                  // 월간 = 기본 캘린더
let CAL_W = localStorage.getItem('planner.cal.w') || null;    // 위클리 = 별도 캘린더

/** 출처에 맞는 캘린더 id */
const calOf = src => (src === 'w' && CAL_W) ? CAL_W : CAL_M;

/** 위클리 캘린더를 찾고, 없으면 만듭니다. */
async function ensureCalendars() {
  if (CAL_W) return CAL_W;
  const j = await api(`${CAL_API}/users/me/calendarList?maxResults=250`);
  const hit = (j.items || []).find(c => c.summary === CFG.WEEKLY_CALENDAR);
  if (hit) {
    CAL_W = hit.id;
  } else {
    const made = await api(`${CAL_API}/calendars`, {
      method: 'POST',
      body: JSON.stringify({
        summary: CFG.WEEKLY_CALENDAR,
        description: '플래너 위클리 화면에 적은 일정',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
    });
    CAL_W = made.id;
  }
  localStorage.setItem('planner.cal.w', CAL_W);
  return CAL_W;
}

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
function normalizeEvent(g, calId) {
  const allDay = !!g.start?.date;
  const rows = [];
  // 정렬 기준: 사용자가 끌어서 정한 순서(plannerOrder)가 있으면 그 값,
  // 없으면 만들어진 시각 → 기본이 "추가한 순서"가 됩니다.
  const rawOrder = g.extendedProperties?.private?.plannerOrder;
  const order   = rawOrder != null && rawOrder !== '' ? Number(rawOrder) : null;
  const created = g.created ? Date.parse(g.created) : 0;
  // 어느 화면에서 넣었는지: 'w' = 위클리, 그 외(없음 포함) = 월간
  // 구글 캘린더 앱에서 직접 넣은 일정은 표시가 없으므로 월간에 보입니다.
  // 어느 캘린더에서 왔는지로 판단합니다.
  // 예전에 기본 캘린더에 저장된 위클리 일정도 계속 위클리로 보이도록 표시를 함께 봅니다.
  const src = (calId && calId === CAL_W) ? 'w'
            : (g.extendedProperties?.private?.plannerSrc === 'w' ? 'w' : 'm');
  // 반복 일정이면 원본(마스터) id 가 함께 옵니다
  const meta = { order: Number.isFinite(order) ? order : null, created, src,
                 seriesId: g.recurringEventId || null,
                 color: GCAL_TO_COLOR[g.colorId] || '',
                 cal: calId || CAL_M };
  if (allDay) {
    const from = parseYmd(g.start.date);
    const to   = parseYmd(g.end.date);              // end 는 제외 경계
    const sd   = g.start.date;
    const ed   = ymd(addDays(to, -1));              // 마지막 날 (포함)
    // 이어지는 날짜에 걸친 일정인지 — 월간에서 한 줄 막대로 그릴 때 씁니다
    const span = { sd, ed, multi: ed > sd, days: Math.max(1, Math.round((to - from) / 86400000)) };

    for (let d = new Date(from); d < to; d = addDays(d, 1)) {
      rows.push({ ...meta, ...span, id: g.id, date: ymd(d), allDay: true, time: null,
                  text: g.summary || '(제목 없음)', note: g.description || '' });
    }
    if (!rows.length) {
      rows.push({ ...meta, ...span, id: g.id, date: sd, allDay: true, time: null,
                  text: g.summary || '(제목 없음)', note: g.description || '' });
    }
  } else {
    const s = new Date(g.start.dateTime);
    const ds = ymd(s);
    rows.push({ ...meta, id: g.id, date: ds, allDay: false,
                sd: ds, ed: ds, multi: false, days: 1,
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
  for (const [g, calId] of list) {
    for (const ev of normalizeEvent(g, calId)) {
      if (ev.date < fromKey || ev.date > toKey) continue;
      if (!store.events.has(ev.date)) store.events.set(ev.date, []);
      store.events.get(ev.date).push(ev);
    }
  }
  for (const arr of store.events.values()) arr.sort((a, b) => orderKey(a) - orderKey(b));
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
  await ensureCalendars();
  const [jm, jw] = await Promise.all([
    api(`${calBase(CAL_M)}?${qs}`),
    api(`${calBase(CAL_W)}?${qs}`)
  ]);
  indexEvents([
    ...(jm.items || []).map(x => [x, CAL_M]),
    ...(jw.items || []).map(x => [x, CAL_W])
  ], ymd(from), ymd(addDays(to, -1)));
  store.loadedMonths.add(mk);
  saveCache();
}

const eventsOn = dateStr => store.events.get(dateStr) || [];

/** 정렬값. 끌어서 정한 순서가 있으면 그것, 없으면 만들어진 시각(=추가한 순서) */
const orderKey = e => (e.order != null ? e.order : e.created);

/* 화면별로 보여줄 일정의 범위.
   월간과 위클리는 서로 겹치지 않게 나눠 가집니다.
   구글 캘린더 앱에서 직접 넣어 출처 표시가 없는 일정은 월간에 들어갑니다. */
const SCOPE = {
  m: e => e.src !== 'w',                   // 월간 : 월간에서 넣은 것 + 외부에서 들어온 것
  w: e => e.src === 'w',                   // 위클리 : 위클리에서 넣은 것만
  m1: e => e.src !== 'w' && !e.multi       // 월간에서 끌어 옮길 수 있는 것 = 하루짜리만
};
const eventsFor = (dateStr, scope) => eventsOn(dateStr).filter(SCOPE[scope]);

/* ---------------- 일정 색상 ----------------
   구글 캘린더의 색상 필드(colorId)에 저장합니다. 그래서 아이폰 기본 캘린더나
   구글 캘린더 앱에서도 같은 일정이 다른 색으로 구분되어 보입니다.
   화면에 그릴 때는 아래 파스텔 조합을 씁니다. */
const EV_COLORS = {
  blue:     { name: '블루',     gcal: '1' },
  sage:     { name: '세이지',   gcal: '2' },
  lavender: { name: '라벤더',   gcal: '3' },
  apricot:  { name: '애프리콧', gcal: '6' },
  rose:     { name: '로즈',     gcal: '4' }
};
const GCAL_TO_COLOR = Object.fromEntries(
  Object.entries(EV_COLORS).map(([k, v]) => [v.gcal, k]));

/** 화면 요소에 붙일 색상 클래스 (기본색이면 빈 문자열) */
const colorCls = e => (e.color ? ' c-' + e.color : '');

/* ---------------- 반복 규칙 ---------------- */
const RR_DAYS = ['SU','MO','TU','WE','TH','FR','SA'];
const RR_KO   = { SU:'일', MO:'월', TU:'화', WE:'수', TH:'목', FR:'금', SA:'토' };

/** 편집창 입력 → 구글이 쓰는 RRULE 문자열 */
function buildRecurrence(f) {
  if (!f.rep) return null;
  const d = parseYmd(f.date);
  let r;
  switch (f.rep) {
    case 'DAILY':       r = 'FREQ=DAILY'; break;
    case 'WEEKLY':      r = 'FREQ=WEEKLY;BYDAY=' +
                            (f.repDays && f.repDays.length ? f.repDays.join(',') : RR_DAYS[d.getDay()]); break;
    case 'MONTHLY_DAY': r = 'FREQ=MONTHLY;BYMONTHDAY=' + d.getDate(); break;
    case 'MONTHLY_NTH': r = 'FREQ=MONTHLY;BYDAY=' +
                            (Math.floor((d.getDate() - 1) / 7) + 1) + RR_DAYS[d.getDay()]; break;
    case 'YEARLY':      r = 'FREQ=YEARLY'; break;
    default: return null;
  }
  if (f.repEnd === 'count' && f.repCount > 0) {
    r += ';COUNT=' + f.repCount;
  } else if (f.repEnd === 'until' && f.repUntil) {
    const u = parseYmd(f.repUntil); u.setHours(23, 59, 59, 0);
    r += ';UNTIL=' + u.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  return ['RRULE:' + r];
}

/** RRULE → 사람이 읽는 문장 ("매주 월·수요일 · 10회") */
function recurrenceText(recurrence) {
  const rule = (recurrence || []).find(x => x.startsWith('RRULE'));
  if (!rule) return '반복';
  const get = k => (rule.match(new RegExp('[;:]' + k + '=([^;]+)')) || [])[1];
  const freq = get('FREQ');
  let t = { DAILY: '매일', WEEKLY: '매주', MONTHLY: '매월', YEARLY: '매년' }[freq] || '반복';

  const byday = get('BYDAY');
  if (freq === 'WEEKLY' && byday) {
    t += ' ' + byday.split(',').map(x => RR_KO[x.slice(-2)] || x).join('·') + '요일';
  }
  if (freq === 'MONTHLY') {
    const bmd = get('BYMONTHDAY');
    if (bmd) t += ' ' + bmd + '일';
    else if (byday) t += ` ${parseInt(byday, 10) || ''}번째 ${RR_KO[byday.slice(-2)] || ''}요일`;
  }
  const cnt = get('COUNT');
  if (cnt) t += ` · ${cnt}회`;
  const until = get('UNTIL');
  if (until) t += ` · ${until.slice(0,4)}.${until.slice(4,6)}.${until.slice(6,8)}까지`;
  return t;
}

/* ---------------- 일정 쓰기 ---------------- */
function eventBody(f) {
  const body = { summary: f.text, description: f.note || '' };
  // 색을 고르지 않았으면 null 로 보내 기본색으로 되돌립니다
  body.colorId = EV_COLORS[f.color] ? EV_COLORS[f.color].gcal : null;
  if (f.allDay) {
    // 여러 날에 걸친 일정은 기간을 유지합니다 (수정할 때 하루로 줄어들지 않도록)
    body.start = { date: f.date };
    body.end   = { date: ymd(addDays(parseYmd(f.date), Math.max(1, f.spanDays || 1))) };
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
  const body = eventBody(f);
  body.extendedProperties = { private: { plannerSrc: f.src === 'w' ? 'w' : 'm' } };
  const rec = buildRecurrence(f);
  if (rec) body.recurrence = rec;
  await ensureCalendars();
  await api(calBase(calOf(f.src)), { method: 'POST', body: JSON.stringify(body) });
  await refreshAround(parseYmd(f.date));
}
async function updateEvent(id, f, cal) {
  // PATCH 는 건드리지 않은 필드(참석자·알림 등)를 그대로 보존합니다
  const body = eventBody(f);
  if (f.repEditable) {
    const rec = buildRecurrence(f);
    body.recurrence = rec || [];        // 빈 배열 = 반복 해제
  }
  await api(`${calBase(cal || calOf(f.src))}/${encodeURIComponent(id)}`,
            { method: 'PATCH', body: JSON.stringify(body) });
  await refreshAround(parseYmd(f.date));
}

/** 반복 일정 전체(원본)를 지웁니다. */
async function deleteSeries(seriesId, dateStr, cal) {
  await api(`${calBase(cal || CAL_M)}/${encodeURIComponent(seriesId)}`, { method: 'DELETE' });
  store.loadedMonths.clear();
  await loadMonth(parseYmd(dateStr), true);
}

/** 이 회차 앞에 실제로 몇 번 반복됐는지 셉니다 (COUNT 로 끝나는 반복을 나눌 때 필요). */
async function countInstancesBefore(seriesId, cutDateStr, cal) {
  const qs = new URLSearchParams({
    timeMax: parseYmd(cutDateStr).toISOString(), maxResults: '2500'
  });
  const j = await api(`${calBase(cal || CAL_M)}/${encodeURIComponent(seriesId)}/instances?${qs}`);
  return (j.items || []).length;
}

/** [이 일정 이후 모두] 수정.
    원래 반복은 직전까지로 자르고, 이 회차부터 새 반복을 만들어 바뀐 내용을 넣습니다. */
async function updateSeriesAfter(seriesId, fromDate, f, ev) {
  const cal = ev.cal || CAL_M;
  const master = await api(`${calBase(cal)}/${encodeURIComponent(seriesId)}`);
  const rrule = (master.recurrence || []).find(x => x.startsWith('RRULE')) || 'RRULE:FREQ=WEEKLY';

  // 횟수로 끝나는 반복이면, 남은 횟수를 계산해 새 반복에 넘겨줍니다
  let newRule = rrule;
  const cnt = (rrule.match(/COUNT=(\d+)/) || [])[1];
  if (cnt) {
    const before = await countInstancesBefore(seriesId, fromDate, cal);
    newRule = rrule.replace(/COUNT=\d+/, 'COUNT=' + Math.max(1, Number(cnt) - before));
  }

  await truncateSeries(seriesId, fromDate, cal);   // 앞쪽은 원래대로 남깁니다

  const body = eventBody(f);
  body.recurrence = [newRule];
  body.extendedProperties = { private: { plannerSrc: ev.src === 'w' ? 'w' : 'm' } };
  await api(calBase(cal), { method: 'POST', body: JSON.stringify(body) });

  store.loadedMonths.clear();
  await loadMonth(parseYmd(f.date), true);
}

/** [반복 전체] 수정. 제목·메모와 시각을 원본에 적용합니다.
    날짜를 옮기는 것은 반복 시작일 자체가 흔들리므로 여기서는 다루지 않습니다. */
async function updateSeriesAll(seriesId, f, cal) {
  cal = cal || CAL_M;
  const master = await api(`${calBase(cal)}/${encodeURIComponent(seriesId)}`);
  const body = { summary: f.text, description: f.note || '' };
  body.colorId = EV_COLORS[f.color] ? EV_COLORS[f.color].gcal : null;

  if (!f.allDay && master.start?.dateTime) {
    const [h, m] = (f.time || '09:00').split(':').map(Number);
    const s = new Date(master.start.dateTime);
    s.setHours(h, m, 0, 0);
    const dur = master.end?.dateTime
      ? new Date(master.end.dateTime) - new Date(master.start.dateTime)
      : 60 * 60 * 1000;
    body.start = { dateTime: s.toISOString() };
    body.end   = { dateTime: new Date(s.getTime() + dur).toISOString() };
  }

  await api(`${calBase(cal)}/${encodeURIComponent(seriesId)}`,
            { method: 'PATCH', body: JSON.stringify(body) });
  store.loadedMonths.clear();
  await loadMonth(parseYmd(f.date), true);
}

/** 이 회차부터 뒤쪽 반복을 잘라냅니다 (앞쪽 지난 일정은 그대로 남습니다).
    반복 규칙의 종료 조건을 "바로 앞 회차까지"로 다시 써서 처리합니다. */
async function truncateSeries(seriesId, fromDateStr, cal) {
  cal = cal || CAL_M;
  const master = await api(`${calBase(cal)}/${encodeURIComponent(seriesId)}`);
  const allDay = !!master.start?.date;
  const masterStart = allDay
    ? master.start.date
    : (master.start?.dateTime ? ymd(new Date(master.start.dateTime)) : null);

  // 첫 회차부터 지우는 것이면 남는 게 없으므로 반복 자체를 삭제합니다
  if (!masterStart || fromDateStr <= masterStart) {
    await deleteSeries(seriesId, fromDateStr, cal);
    return 'all';
  }

  // 종료 시점 = 이 회차 바로 직전
  // 종일 일정은 날짜 형식(YYYYMMDD), 시간 있는 일정은 UTC 시각 형식이어야 합니다
  let until;
  if (allDay) {
    until = ymd(addDays(parseYmd(fromDateStr), -1)).replace(/-/g, '');
  } else {
    const cut = new Date(parseYmd(fromDateStr).getTime() - 1000);   // 전날 23:59:59
    until = cut.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  const recurrence = (master.recurrence || []).map(line =>
    line.startsWith('RRULE')
      ? line.replace(/;?(UNTIL|COUNT)=[^;]*/g, '') + ';UNTIL=' + until
      : line
  );

  await api(`${calBase(cal)}/${encodeURIComponent(seriesId)}`,
            { method: 'PATCH', body: JSON.stringify({ recurrence }) });
  store.loadedMonths.clear();
  await loadMonth(parseYmd(fromDateStr), true);
  return 'after';
}

/** 캘린더에 있는 모든 반복 일정(원본)을 모아옵니다. */
async function listRecurringSeries() {
  await ensureCalendars();
  const out = [];
  for (const cal of [CAL_M, CAL_W]) {
    let pageToken = null;
    do {
      const qs = new URLSearchParams({ singleEvents: 'false', maxResults: '250', showDeleted: 'false' });
      if (pageToken) qs.set('pageToken', pageToken);
      const j = await api(`${calBase(cal)}?${qs}`);
      for (const it of (j.items || [])) {
        if (!it.recurrence || !it.recurrence.length) continue;
        out.push({
          id: it.id, cal,
          where: cal === CAL_W ? '위클리' : '월간',
          text: it.summary || '(제목 없음)',
          start: it.start?.date || (it.start?.dateTime ? ymd(new Date(it.start.dateTime)) : ''),
          rule: recurrenceText(it.recurrence)
        });
      }
      pageToken = j.nextPageToken || null;
    } while (pageToken);
  }
  out.sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.text.localeCompare(b.text));
  return out;
}
async function deleteEvent(id, dateStr, cal) {
  await api(`${calBase(cal || CAL_M)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refreshAround(parseYmd(dateStr));
}

/** 끌어서 놓은 위치를 구글에 저장합니다.
    앞뒤 항목의 정렬값 사이 중간값을 새 순서로 써서, 한 번에 한 건만 고치면 됩니다. */
async function reorderEvent(id, fromDate, toDate, index, scope = 'm') {
  const cal = calOf(scope === 'w' ? 'w' : 'm');
  // 놓은 위치(index)는 그 화면에 보이는 것들 기준이므로, 이웃도 같은 범위에서 찾습니다
  const rest = eventsFor(toDate, scope).filter(e => e.id !== id);
  const prev = index > 0            ? orderKey(rest[index - 1]) : null;
  const next = index < rest.length  ? orderKey(rest[index])     : null;

  let val;
  if      (prev == null && next == null) val = Date.now();
  else if (prev == null)                 val = next - 60000;
  else if (next == null)                 val = prev + 60000;
  else                                   val = (prev + next) / 2;

  // 중간값을 만들 자리가 없을 만큼 촘촘해지면 그 날짜 전체를 다시 번호 매깁니다
  if (prev != null && next != null && Math.abs(next - prev) < 2) {
    await renumberDay(toDate, scope);
    return reorderEvent(id, fromDate, toDate, index, scope);
  }

  // private 맵은 통째로 교체되므로 출처 표시도 함께 다시 써 줍니다
  const moving = eventsOn(fromDate).find(e => e.id === id) || {};
  const body = { extendedProperties: { private: {
    plannerOrder: String(Math.round(val)),
    plannerSrc: moving.src === 'w' ? 'w' : 'm'
  } } };

  // 다른 요일로 옮긴 경우 날짜도 함께 바꿉니다
  if (toDate !== fromDate) {
    const ev = eventsOn(fromDate).find(e => e.id === id);
    if (ev) Object.assign(body, eventBody({
      date: toDate, allDay: ev.allDay, time: ev.time, text: ev.text, note: ev.note
    }));
    delete body.summary; delete body.description;   // 내용은 건드리지 않습니다
  }

  await api(`${calBase(cal)}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  await refreshAround(parseYmd(toDate));
  if (toDate !== fromDate) await refreshAround(parseYmd(fromDate));
}

/** 한 날짜의 정렬값을 넉넉한 간격으로 다시 매깁니다. */
async function renumberDay(dateStr, scope = 'm') {
  const cal = calOf(scope === 'w' ? 'w' : 'm');
  const list = eventsFor(dateStr, scope);
  const base = Date.now();
  for (let i = 0; i < list.length; i++) {
    await api(`${calBase(cal)}/${encodeURIComponent(list[i].id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ extendedProperties: { private: {
        plannerOrder: String(base + i * 60000),
        plannerSrc: list[i].src === 'w' ? 'w' : 'm'
      } } })
    });
  }
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
const MONTH_ROWS = 4;          // 한 칸에 보여줄 최대 줄 수

/** 한 주(7칸) 안에서 여러 날짜에 걸친 일정에 줄 번호를 배정합니다.
    같은 일정이 모든 칸에서 같은 높이에 와야 막대가 끊기지 않고 이어져 보입니다. */
function layoutWeek(days) {
  const ds0 = ymd(days[0]), ds6 = ymd(days[6]);

  const seen = new Map();
  for (const d of days) {
    for (const e of eventsFor(ymd(d), 'm')) {
      if (e.multi && !seen.has(e.id)) seen.set(e.id, e);
    }
  }
  // 먼저 시작한 것, 더 긴 것부터 위쪽 줄을 차지합니다
  const list = [...seen.values()].sort((a, b) =>
    a.sd.localeCompare(b.sd) || b.ed.localeCompare(a.ed) || a.created - b.created);

  const lanes = [];                       // lanes[i] = [{from,to}, ...]
  const laneOf = new Map();
  for (const e of list) {
    const from = e.sd < ds0 ? ds0 : e.sd;
    const to   = e.ed > ds6 ? ds6 : e.ed;
    let ln = 0;
    while (lanes[ln] && lanes[ln].some(s => !(to < s.from || from > s.to))) ln++;
    (lanes[ln] = lanes[ln] || []).push({ from, to });
    laneOf.set(e.id, ln);
  }

  const laneCount  = lanes.length;
  const shownLanes = Math.min(laneCount, MONTH_ROWS);

  return {
    shownLanes,
    /** 그 날짜의 ln 번째 줄에 오는 일정 (없으면 null) */
    at(ds, ln) {
      for (const e of seen.values()) {
        if (laneOf.get(e.id) === ln && e.sd <= ds && ds <= e.ed) return e;
      }
      return null;
    },
    /** 줄이 모자라 못 그린 여러 날 일정 수 */
    hiddenAt(ds) {
      let n = 0;
      for (const e of seen.values()) {
        if (laneOf.get(e.id) >= shownLanes && e.sd <= ds && ds <= e.ed) n++;
      }
      return n;
    }
  };
}

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
  for (let w = 0; w * 7 < cells; w++) {
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(gridStart, w * 7 + i));
    const lay = layoutWeek(days);            // 여러 날 일정에 줄(lane)을 배정

    days.forEach((d, i) => {
      const ds = ymd(d);
      const kind = dayKind(d);
      const label = holidayOf(d) || termOf(d) || '';
      const weekly = eventsFor(ds, 'w');

      // ① 여러 날 막대 — 주 안에서 같은 줄에 오도록 빈 자리는 자리표로 채웁니다
      let rows = '';
      for (let ln = 0; ln < lay.shownLanes; ln++) {
        const e = lay.at(ds, ln);
        if (!e) { rows += '<span class="evspacer"></span>'; continue; }
        const contL = e.sd < ds, contR = e.ed > ds;
        const cls = ['pill', 'bar'];
        if (contL) cls.push('cl');
        if (contR) cls.push('cr');
        if (contL && i > 0) cls.push('bl');    // 왼쪽 칸과 붙이기
        if (contR && i < 6) cls.push('br');    // 오른쪽 칸과 붙이기
        // 제목은 시작한 칸에서 한 번만. 주가 넘어가면 그 줄 첫 칸에 다시 보여줍니다.
        const showText = (e.sd === ds) || (i === 0);
        if (e.color) cls.push('c-' + e.color);
        rows += `<span class="${cls.join(' ')}" data-id="${e.id}"
                       title="${esc(e.text)}">${showText ? esc(e.text) : ''}</span>`;
      }

      // ② 하루짜리 일정 — 남은 줄만큼
      const singles = eventsFor(ds, 'm1');
      const room = Math.max(0, MONTH_ROWS - lay.shownLanes);
      const shown = singles.slice(0, room);
      shown.forEach(e => {
        rows += `<span class="pill ${e.allDay ? '' : 'timed'}${colorCls(e)}" data-id="${e.id}"
                       ${e.time ? `data-t="${e.time}"` : ''}>${esc(e.text)}</span>`;
      });

      const hidden = (singles.length - shown.length) + lay.hiddenAt(ds);
      const wbtn = weekly.length
        ? `<button class="wbtn" data-date="${ds}" title="위클리에 적은 일정 ${weekly.length}건">W${
            weekly.length > 1 ? `<sup>${weekly.length}</sup>` : ''}</button>`
        : '';

      html += `<div class="mcell ${kind} ${d.getMonth() !== a.getMonth() ? 'other' : ''}
                          ${sameDay(d, today) ? 'is-today' : ''}" data-date="${ds}">
          <div class="dhead"><span class="dn">${d.getDate()}</span>${wbtn}</div>
          <div class="dt">${esc(label)}</div>
          <div class="evs">${rows}${hidden > 0 ? `<span class="more">+${hidden}</span>` : ''}</div>
        </div>`;
    });
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
    const evs = eventsFor(ds, 'w');      // 월간에서 넣은 일정은 위클리에 나오지 않습니다

    let lines = '';
    for (let k = 0; k < Math.max(LINES, evs.length); k++) {
      const e = evs[k];
      lines += e
        ? `<button class="wline${colorCls(e)}" data-id="${e.id}" data-date="${ds}">
             <span class="grip" aria-hidden="true"></span>
             ${e.time ? `<span class="wt">${e.time}</span>` : ''}
             <span class="wx">${esc(e.text)}</span></button>`
        : `<button class="wline empty" data-date="${ds}"></button>`;
    }

    html += `<div class="wcol ${dayKind(d)} ${sameDay(d, today) ? 'is-today' : ''}" data-date="${ds}">
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

  // 오늘 화면은 월간·위클리 것을 모두 보여주되, 앞에 M / W 로 출처를 표시합니다
  const evs = eventsOn(ds);
  $('#today-events').innerHTML = evs.length
    ? evs.map(e => {
        const w = e.src === 'w';
        return `<button class="ev${colorCls(e)}" data-id="${e.id}" data-date="${ds}">
         <span class="src ${w ? 'w' : 'm'}" title="${w ? '위클리에서 추가' : '월간에서 추가'}">${w ? 'W' : 'M'}</span>
         <span class="t">${e.allDay ? '종일' : e.time}</span>
         <span class="x">${esc(e.text)}</span></button>`;
      }).join('')
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
let editing  = null;   // { id, date } | null
let sheetSrc = 'm';   // 새로 만들 때 기록할 출처 : 'm' 월간 / 'w' 위클리

function openSheet(dateStr, id, src) {
  sheetSrc = src || (state.view === 'week' ? 'w' : 'm');
  const evs = eventsOn(dateStr);
  const ev = id ? evs.find(e => e.id === id) : null;
  editing = ev ? { id: ev.id, date: dateStr } : null;

  $('#ev-title').textContent = ev ? '일정 수정' : '새 일정';
  $('#ev-text').value  = ev ? ev.text : '';
  // 여러 날 일정은 어느 칸을 눌렀든 시작일과 종료일을 함께 보여줍니다
  $('#ev-date').value    = ev ? ev.sd : dateStr;
  $('#ev-enddate').value = ev ? ev.ed : dateStr;
  $('#ev-note').value  = ev ? ev.note : '';
  setColorPick(ev ? ev.color : '');
  $('#ev-allday').checked = ev ? ev.allDay : true;
  $('#ev-time').value  = ev && ev.time ? ev.time : '09:00';
  syncDateFields();

  // 반복 : 새 일정과 반복이 아닌 일정은 설정 가능, 반복 중 하나면 잠급니다
  const inSeries = !!(ev && ev.seriesId);
  $('#ev-rep').value = '';
  $('#ev-repend').value = 'none';
  $('#ev-repcount').value = 10;
  $('#ev-repuntil').value = '';
  $('#ev-rep').disabled = inSeries;
  $('#rep-note').hidden = !inSeries;
  if (inSeries) $('#rep-note').textContent =
    '반복되는 일정입니다. 저장할 때 어디까지 적용할지 고를 수 있습니다.';
  syncRepFields();

  $('#ev-delete').hidden = !ev;
  $('#ev-delete').textContent = inSeries ? '이 날짜만 삭제' : '이 일정 삭제';
  $('#ev-delete-after').hidden = !inSeries;
  $('#ev-delete-all').hidden   = !inSeries;

  $('#sheet').hidden = false;
  setTimeout(() => $('#ev-text').focus(), 60);
}
function closeSheet() { $('#sheet').hidden = true; editing = null; }

/** 반복 일정을 저장할 때 "어디까지 적용할지" 묻습니다.
    'one' | 'after' | 'all' 을 돌려주고, 취소하면 null 을 돌려줍니다. */
function askScope() {
  return new Promise(resolve => {
    const box = $('#scopeask');
    box.hidden = false;
    const done = v => { box.hidden = true; box.onclick = null; resolve(v); };
    box.onclick = e => {
      const b = e.target.closest('[data-scope]');
      if (b) return done(b.dataset.scope || null);
      if (e.target.id === 'scopeask') done(null);      // 바깥을 누르면 취소
    };
  });
}

/** 고른 반복 종류에 따라 요일 선택·종료 조건 칸을 보여주거나 숨깁니다. */
function syncRepFields() {
  const rep = $('#ev-rep').value;
  $('#rep-days').hidden = (rep !== 'WEEKLY');
  $('#rep-end').hidden  = !rep;
  const mode = $('#ev-repend').value;
  $('#rep-count-wrap').hidden = (mode !== 'count');
  $('#rep-until-wrap').hidden = (mode !== 'until');
}

/** '하루 종일' 여부에 따라 종료일 / 시간 칸을 바꿔 보여줍니다. */
function syncDateFields() {
  const allDay = $('#ev-allday').checked;
  $('#ev-end-wrap').hidden  = !allDay;
  $('#ev-time-wrap').hidden = allDay;
  $('#ev-date-lbl').textContent = allDay ? '시작일' : '날짜';
  // 종료일이 시작일보다 앞서면 시작일에 맞춥니다
  if (allDay && $('#ev-enddate').value < $('#ev-date').value) {
    $('#ev-enddate').value = $('#ev-date').value;
  }
}

/** 색상 고르는 칸을 만듭니다. 미리보기 글자로 대비를 바로 확인할 수 있게 합니다. */
function buildColorPick() {
  let h = '<button type="button" class="sw on" data-c="" title="기본">가</button>';
  for (const [key, v] of Object.entries(EV_COLORS)) {
    h += `<button type="button" class="sw c-${key}" data-c="${key}" title="${v.name}">가</button>`;
  }
  $('#ev-color').innerHTML = h;
}

function setColorPick(key) {
  $$('#ev-color .sw').forEach(b => b.classList.toggle('on', b.dataset.c === (key || '')));
}

/** 매주 반복용 요일 버튼을 만듭니다. */
function buildDayPicker() {
  const order = CFG.WEEK_START === 1 ? [1,2,3,4,5,6,0] : [0,1,2,3,4,5,6];
  $('#rep-days').innerHTML = order.map(i =>
    `<button type="button" class="dowbtn ${i===0?'sun':i===6?'sat':''}" data-d="${RR_DAYS[i]}">${DOW_KR[i]}</button>`
  ).join('');
}

async function saveSheet() {
  const f = {
    text: $('#ev-text').value.trim(),
    date: $('#ev-date').value,
    time: $('#ev-time').value,
    allDay: $('#ev-allday').checked,
    note: $('#ev-note').value.trim(),
    src: sheetSrc,
    spanDays: 1,
    color: $('#ev-color .sw.on')?.dataset.c || '',
    rep:        $('#ev-rep').value,
    repDays:    $$('#rep-days .dowbtn.on').map(b => b.dataset.d),
    repEnd:     $('#ev-repend').value,
    repCount:   Number($('#ev-repcount').value) || 0,
    repUntil:   $('#ev-repuntil').value,
    repEditable: !$('#ev-rep').disabled      // 반복 중 하나면 규칙을 건드리지 않습니다
  };
  // 종일 일정은 시작일~종료일 사이 날 수를 기간으로 씁니다
  if (f.allDay) {
    const endStr = $('#ev-enddate').value || f.date;
    const n = Math.round((parseYmd(endStr) - parseYmd(f.date)) / 86400000) + 1;
    f.spanDays = Math.max(1, n || 1);
  }
  if (f.rep === 'WEEKLY' && !f.repDays.length) {
    f.repDays = [RR_DAYS[parseYmd(f.date).getDay()]];   // 요일을 안 고르면 그 날 요일로
  }
  if (!f.text) { toast('내용을 입력해 주세요'); return; }
  if (!f.date) { toast('날짜를 선택해 주세요'); return; }

  // closeSheet() 가 editing 을 비우므로, 닫기 전에 먼저 붙잡아 둡니다.
  const target  = editing;
  const wasDate = target ? target.date : null;
  const ev      = target ? eventsOn(wasDate).find(x => x.id === target.id) : null;
  const inSeries = !!(ev && ev.seriesId);

  // 반복 일정이면 어디까지 적용할지 먼저 묻습니다
  let scope = 'one';
  if (inSeries) {
    scope = await askScope();
    if (!scope) return;                 // 취소하면 편집창을 그대로 둡니다
  }
  closeSheet();

  await guard(async () => {
    if (!target)              await createEvent(f);
    else if (!inSeries)       await updateEvent(target.id, f, ev.cal);
    else if (scope === 'one') await updateEvent(target.id, f, ev.cal);
    else if (scope === 'after') await updateSeriesAfter(ev.seriesId, wasDate, f, ev);
    else                        await updateSeriesAll(ev.seriesId, f, ev.cal);

    // 날짜를 옮긴 경우 원래 있던 달도 다시 불러와야 그 화면에서 사라집니다
    if (wasDate && wasDate !== f.date) await refreshAround(parseYmd(wasDate));
    renderAll();
    const msg = { one: '이 일정만 수정했습니다',
                  after: '이 일정 이후를 모두 수정했습니다',
                  all: '반복 전체를 수정했습니다' };
    toast(!target ? '저장했습니다' : (inSeries ? msg[scope] : '수정했습니다'));
  }, '저장 중…');
}

/* ---------------- W 팝업 : 그 날 위클리에 적은 일정 ---------------- */
function openWeeklyPopup(dateStr) {
  const d = parseYmd(dateStr);
  const list = eventsFor(dateStr, 'w');

  $('#wp-title').textContent =
    `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_KR[d.getDay()]}) · 위클리`;
  $('#wp-list').innerHTML = list.length
    ? list.map(e => `<button class="ev" data-id="${e.id}">
         <span class="t">${e.allDay ? '종일' : e.time}</span>
         <span class="x">${esc(e.text)}</span></button>`).join('')
    : '<div class="empty-note">위클리에 적은 일정이 없습니다.</div>';

  $('#wpop').dataset.date = dateStr;
  $('#wpop').hidden = false;
}
function closeWeeklyPopup() { $('#wpop').hidden = true; }

/** 예전에 기본 캘린더에 저장된 위클리 일정을 위클리 캘린더로 옮깁니다. */
async function migrateWeeklyEvents() {
  await ensureCalendars();
  const ids = [];
  let pageToken = null;
  do {
    const qs = new URLSearchParams({ singleEvents: 'false', maxResults: '250', showDeleted: 'false' });
    if (pageToken) qs.set('pageToken', pageToken);
    const j = await api(`${calBase(CAL_M)}?${qs}`);
    for (const it of (j.items || [])) {
      if (it.extendedProperties?.private?.plannerSrc === 'w') ids.push(it.id);
    }
    pageToken = j.nextPageToken || null;
  } while (pageToken);

  let done = 0;
  for (const id of ids) {
    // 구글의 move 기능을 쓰면 반복·색상까지 그대로 옮겨집니다
    await api(`${calBase(CAL_M)}/${encodeURIComponent(id)}/move?destination=${encodeURIComponent(CAL_W)}`,
              { method: 'POST' });
    done++;
    setSync(`옮기는 중… ${done}/${ids.length}`, 'busy');
  }
  store.loadedMonths.clear();
  await loadMonth(state.anchor, true);
  return done;
}

/* ---------------- 반복 일정 관리 (일괄 삭제) ---------------- */
let series = [];

function openManager() {
  $('#mgr').hidden = false;
  $('#mg-list').innerHTML = '<div class="empty-note">불러오는 중…</div>';
  $('#mg-count').textContent = '';
  guard(async () => {
    series = await listRecurringSeries();
    renderManager();
  }, '반복 일정 찾는 중…');
}

function renderManager() {
  $('#mg-list').innerHTML = series.length
    ? series.map(x => `<label class="task mgrow">
         <input type="checkbox" class="mgchk" value="${x.id}">
         <span class="lbl">
           <span class="mg-t">${esc(x.text)}</span>
           <span class="mg-s">${esc(x.where)} · ${esc(x.rule)}${x.start ? ' · ' + x.start + ' 시작' : ''}</span>
         </span></label>`).join('')
    : '<div class="empty-note">반복으로 설정된 일정이 없습니다.</div>';
  updateMgCount();
}

function updateMgCount() {
  const n = $$('#mg-list .mgchk:checked').length;
  $('#mg-count').textContent = series.length
    ? `${series.length}건 중 ${n}건 선택` : '';
}

async function deleteSelectedSeries() {
  const ids = $$('#mg-list .mgchk:checked').map(c => c.value);
  if (!ids.length) return toast('삭제할 항목을 골라 주세요');
  if (!confirm(`반복 일정 ${ids.length}건을 지웁니다.
각 일정의 모든 회차가 함께 삭제되며 되돌릴 수 없습니다.
계속할까요?`)) return;

  await guard(async () => {
    let done = 0;
    for (const id of ids) {
      try {
        const row = series.find(x => x.id === id);
        await api(`${calBase(row?.cal || CAL_M)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        done++;
      } catch (e) {
        if (!/^(404|410)/.test(e.message)) throw e;   // 이미 지워진 건 넘어갑니다
        done++;
      }
      setSync(`삭제 중… ${done}/${ids.length}`, 'busy');
    }
    series = series.filter(x => !ids.includes(x.id));
    renderManager();
    store.loadedMonths.clear();
    await loadMonth(state.anchor, true);
    renderAll();
    toast(`반복 일정 ${done}건을 삭제했습니다`);
  }, '삭제 중…');
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

/* ============================================================
   끌어서 순서 바꾸기 — 마우스와 터치(아이패드·폰) 모두 지원
   마우스: 6px 이상 끌면 시작 / 터치: 손잡이를 260ms 누르고 있으면 시작
   ============================================================ */
let dragBlockClick = false;      // 끌고 난 직후의 click 이 편집창을 열지 않도록

function enableDragSort(root, opt) {
  let st = null;

  const stop = () => {
    if (!st) return;
    clearTimeout(st.timer);
    st.el.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    st = null;
  };

  const begin = () => {
    st.active = true;
    st.el.classList.add('dragging');
    document.body.classList.add('is-dragging');
  };

  root.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    const h = e.target.closest(opt.handle);
    if (!h) return;
    const el = h.closest(opt.item);
    if (!el || !el.dataset.id) return;

    const listEl = el.closest(opt.list);
    st = { el, id: el.dataset.id, fromDate: opt.dateOf(listEl),
           x: e.clientX, y: e.clientY, active: false, timer: null };

    if (e.pointerType !== 'mouse') st.timer = setTimeout(() => { if (st) begin(); }, 260);
  });

  window.addEventListener('pointermove', e => {
    if (!st) return;
    if (!st.active) {
      if (Math.hypot(e.clientX - st.x, e.clientY - st.y) < 6) return;
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      if (e.pointerType !== 'mouse') { stop(); return; }   // 터치는 스크롤로 넘김
      begin();
    }
    e.preventDefault();

    st.el.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    st.el.style.pointerEvents = '';
    const listEl = under && under.closest(opt.list);
    if (!listEl) return;

    const items = [...listEl.querySelectorAll(opt.item)].filter(x => x !== st.el && x.dataset.id);
    let before = null;
    for (const it of items) {
      const r = it.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { before = it; break; }
    }
    listEl.insertBefore(st.el, before || (opt.endAnchor ? opt.endAnchor(listEl) : null));
  }, { passive: false });

  window.addEventListener('pointerup', () => {
    if (!st || !st.active) return stop();
    const { el, id, fromDate } = st;
    stop();

    dragBlockClick = true;
    setTimeout(() => { dragBlockClick = false; }, 350);

    const listEl = el.closest(opt.list);
    const toDate = opt.dateOf(listEl);
    const index  = [...listEl.querySelectorAll(opt.item)].filter(x => x.dataset.id).indexOf(el);

    guard(() => reorderEvent(id, fromDate, toDate, index, opt.scope), '순서 저장 중…')
      .then(() => renderAll());
  });

  window.addEventListener('pointercancel', stop);
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

  buildDayPicker();
  buildColorPick();
  $('#ev-color').onclick = e => {
    const b = e.target.closest('.sw');
    if (b) setColorPick(b.dataset.c);
  };

  /* 반복 입력칸 */
  $('#ev-rep').onchange = syncRepFields;
  $('#ev-repend').onchange = syncRepFields;
  $('#rep-days').onclick = e => {
    const b = e.target.closest('.dowbtn');
    if (b) b.classList.toggle('on');
  };

  /* 더보기 메뉴 */
  $('#more-btn').onclick = () => { $('#menu').hidden = false; };
  $('#mi-close').onclick = () => { $('#menu').hidden = true; };
  $('#menu').onclick = e => { if (e.target.id === 'menu') $('#menu').hidden = true; };
  $('#mi-repeat').onclick = () => { $('#menu').hidden = true; openManager(); };
  $('#mi-migrate').onclick = () => {
    $('#menu').hidden = true;
    if (!confirm(`예전에 기본 캘린더에 저장된 위클리 일정을 "위클리" 캘린더로 옮깁니다.
계속할까요?`)) return;
    guard(async () => {
      const n = await migrateWeeklyEvents();
      renderAll();
      toast(n ? `${n}건을 위클리 캘린더로 옮겼습니다` : '옮길 일정이 없습니다');
    }, '옮기는 중…');
  };

  /* 반복 일정 관리 */
  $('#mg-close').onclick = () => { $('#mgr').hidden = true; };
  $('#mgr').onclick = e => { if (e.target.id === 'mgr') $('#mgr').hidden = true; };
  $('#mg-all').onclick  = () => { $$('#mg-list .mgchk').forEach(c => c.checked = true);  updateMgCount(); };
  $('#mg-none').onclick = () => { $$('#mg-list .mgchk').forEach(c => c.checked = false); updateMgCount(); };
  $('#mg-list').onchange = updateMgCount;
  $('#mg-del').onclick = deleteSelectedSeries;

  $('#mi-signout').onclick = () => {
    if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null; tokenExpiry = 0;
    localStorage.removeItem('planner.consented');
    localStorage.removeItem('planner.lists');
    location.reload();
  };

  /* 월간 — 칸/일정 클릭 */
  $('#month-grid').onclick = e => {
    if (dragBlockClick) return;                 // 방금 끌어놓은 것이면 편집창을 열지 않습니다
    const wb = e.target.closest('.wbtn');
    if (wb) { e.stopPropagation(); return openWeeklyPopup(wb.dataset.date); }
    const pill = e.target.closest('.pill');
    if (pill) return openSheet(pill.closest('.mcell').dataset.date, pill.dataset.id, 'm');
    const cell = e.target.closest('.mcell');
    if (cell) openSheet(cell.dataset.date, null, 'm');
  };

  /* W 팝업 */
  $('#wp-close').onclick = closeWeeklyPopup;
  $('#wp-add').onclick = () => {
    const ds = $('#wpop').dataset.date;
    closeWeeklyPopup();
    openSheet(ds, null, 'w');
  };
  $('#wp-list').onclick = e => {
    const b = e.target.closest('.ev');
    if (!b) return;
    const ds = $('#wpop').dataset.date;
    closeWeeklyPopup();
    openSheet(ds, b.dataset.id, 'w');
  };
  $('#wpop').onclick = e => { if (e.target.id === 'wpop') closeWeeklyPopup(); };

  /* 위클리 — 줄 클릭 */
  $('#week-grid').onclick = e => {
    if (dragBlockClick) return;
    const line = e.target.closest('.wline');
    if (line) openSheet(line.closest('.wcol').dataset.date, line.dataset.id || null, 'w');
  };

  /* 끌어서 순서 바꾸기 */
  enableDragSort($('#month-grid'), {
    scope: 'm1',                                       // 여러 날 막대는 끌지 않습니다
    handle: '.pill:not(.bar)', item: '.pill:not(.bar)', list: '.evs',
    dateOf: listEl => listEl.closest('.mcell').dataset.date,
    endAnchor: listEl => listEl.querySelector('.more')      // "+N" 표시 위에 놓이도록
  });
  enableDragSort($('#week-grid'), {
    scope: 'w',
    handle: '.grip', item: '.wline', list: '.wcol',
    dateOf: listEl => listEl.dataset.date,
    endAnchor: listEl => listEl.querySelector('.wline.empty')  // 빈 줄 위에 놓이도록
  });

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
  $('#ev-allday').onchange = syncDateFields;
  $('#ev-date').onchange = () => {
    // 시작일을 옮기면 종료일도 같은 간격만큼 따라갑니다
    const st = $('#ev-date').value, en = $('#ev-enddate').value;
    if (st && en && en < st) $('#ev-enddate').value = st;
  };
  $('#ev-enddate').onchange = syncDateFields;
  $('#ev-delete').onclick = () => {
    if (!editing || !confirm('이 일정을 삭제할까요?')) return;
    const { id, date } = editing;
    const cal = (eventsOn(date).find(x => x.id === id) || {}).cal;
    closeSheet();
    guard(async () => { await deleteEvent(id, date, cal); renderAll(); toast('삭제했습니다'); }, '삭제 중…');
  };
  $('#ev-delete-after').onclick = () => {
    const ev = editing && eventsOn(editing.date).find(x => x.id === editing.id);
    if (!ev || !ev.seriesId) return;
    const date = editing.date;
    const d = parseYmd(date);
    if (!confirm(`${d.getMonth() + 1}월 ${d.getDate()}일부터 뒤쪽 반복을 모두 삭제합니다.
이전 날짜의 일정은 그대로 남습니다. 계속할까요?`)) return;
    const { seriesId, cal } = ev;
    closeSheet();
    guard(async () => {
      const how = await truncateSeries(seriesId, date, cal);
      renderAll();
      toast(how === 'all'
        ? '첫 회차부터라 반복 전체를 삭제했습니다'
        : '이 날짜 이후 반복을 삭제했습니다');
    }, '삭제 중…');
  };

  $('#ev-delete-all').onclick = () => {
    const ev = editing && eventsOn(editing.date).find(x => x.id === editing.id);
    if (!ev || !ev.seriesId) return;
    if (!confirm(`이 일정의 반복 회차를 모두 삭제합니다.
되돌릴 수 없습니다. 계속할까요?`)) return;
    const { seriesId, cal } = ev; const date = editing.date;
    closeSheet();
    guard(async () => {
      await deleteSeries(seriesId, date, cal);
      renderAll();
      toast('반복 일정을 전체 삭제했습니다');
    }, '삭제 중…');
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

/* 요청하는 권한이 바뀌면 예전 로그인으로는 안 되므로 다시 동의를 받습니다.
   (위클리 캘린더를 만들려면 캘린더 관리 권한이 새로 필요해졌습니다) */
const SCOPE_VERSION = '2';

async function boot() {
  if (localStorage.getItem('planner.scopev') !== SCOPE_VERSION) {
    localStorage.removeItem('planner.consented');
    localStorage.removeItem('planner.cal.w');
    localStorage.setItem('planner.scopev', SCOPE_VERSION);
    CAL_W = null;
  }

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
