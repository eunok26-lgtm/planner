/* ============================================================
   아이 할 일 (숙제) — 위클리 아래, 식단 위

   요일마다 그 날 할 일을 적습니다. 체크해서 끝낸 표시를 하고,
   끌어서 순서를 바꾸고, 다른 요일로 옮길 수도 있습니다.

   저장 (구글 드라이브 "플래너 아이할일" 폴더)
     hw-repeat.json      매주 반복하는 것 — 요일(0=일 ~ 6=토)별 목록
     hw-2026-11-16.json  그 주(월요일 기준) 실제 목록

   매주 반복은 '틀' 이고, 주가 열릴 때 그 주 파일로 한 벌 찍어냅니다.
   그래서 이번 주만 지우거나 순서를 바꿔도 다음 주는 그대로입니다.
   ============================================================ */

let HW_ON = localStorage.getItem('planner.hw.on') === '1';

let hwFolderId = localStorage.getItem('planner.hw.folder') || '';
let hwFileIds  = JSON.parse(localStorage.getItem('planner.hw.ids') || '{}');   // 주 → 파일 id
let hwRepeatId = localStorage.getItem('planner.hw.repid') || '';

let hwWeek   = '';      // 지금 화면에 올라와 있는 주 (월요일 'YYYY-MM-DD')
let hwData   = null;    // { days: { 'YYYY-MM-DD': [ {id,text,done,rep} ] } }
let hwRepeat = null;    // { '0'..'6': [ {id,text} ] }
let hwTimer = 0, hwSaving = false, hwAgain = false;

/* days : 그 날 실제 목록 / hide : 그 날 빼 둔 반복 항목 (이번 주만 지웠거나 다른 날로 옮긴 것).
   hide 가 없으면 '이번 주만 지우기' 한 것이 다시 열 때마다 되살아납니다. */
const emptyHw = () => ({ days: {}, hide: {} });
const hwKey = mon => 'hw-' + mon + '.json';
const hwUid = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------- 드라이브 ---------- */

async function hwFolder() {
  if (hwFolderId) return hwFolderId;
  const name = (CFG.HW_FOLDER || '플래너 아이할일');
  const q = "mimeType='application/vnd.google-apps.folder' and name='" +
            name.replace(/'/g, "\\'") + "' and trashed=false";
  const found = await dJson(DRIVE_API + '/files?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1');
  hwFolderId = (found.files && found.files[0] && found.files[0].id) ||
    (await dJson(DRIVE_API + '/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
    })).id;
  localStorage.setItem('planner.hw.folder', hwFolderId);
  return hwFolderId;
}

/** 폴더 안에서 이름으로 파일을 찾습니다 (없으면 빈 문자열) */
async function hwFindFile(name) {
  await hwFolder();
  const q = "'" + hwFolderId + "' in parents and trashed=false and name='" + name + "'";
  const j = await dJson(DRIVE_API + '/files?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1');
  return (j.files && j.files[0] && j.files[0].id) || '';
}

async function hwReadFile(id) {
  return (await dfetch(DRIVE_API + '/files/' + id + '?alt=media')).json();
}

async function hwFetchWeek(mon) {
  let id = hwFileIds[mon] || await hwFindFile(hwKey(mon));
  if (id) { hwFileIds[mon] = id; localStorage.setItem('planner.hw.ids', JSON.stringify(hwFileIds)); }
  return id ? { ...emptyHw(), ...(await hwReadFile(id)) } : emptyHw();
}

async function hwPutWeek(mon, data) {
  await hwFolder();
  const res = await driveUpload({
    id: hwFileIds[mon], name: hwKey(mon), mime: 'application/json',
    parent: hwFolderId, body: JSON.stringify(data),
    appProperties: { planner: 'homework', week: mon }
  });
  hwFileIds[mon] = res.id;
  localStorage.setItem('planner.hw.ids', JSON.stringify(hwFileIds));
}

async function hwFetchRepeat() {
  let id = hwRepeatId || await hwFindFile('hw-repeat.json');
  if (id) { hwRepeatId = id; localStorage.setItem('planner.hw.repid', id); }
  return id ? (await hwReadFile(id)) : {};
}

async function hwPutRepeat(data) {
  await hwFolder();
  const res = await driveUpload({
    id: hwRepeatId || undefined, name: 'hw-repeat.json', mime: 'application/json',
    parent: hwFolderId, body: JSON.stringify(data),
    appProperties: { planner: 'homework-repeat' }
  });
  hwRepeatId = res.id;
  localStorage.setItem('planner.hw.repid', hwRepeatId);
}

/* ---------- 매주 반복을 그 주에 찍어내기 ---------- */

/** 그 날 들어가야 할 반복 항목 — 매일 것 + 그 요일 것 */
const hwRepeatFor = d =>
  [...((hwRepeat && hwRepeat.all) || []), ...((hwRepeat && hwRepeat[String(d.getDay())]) || [])];

/* 틀에서 할 일이 담기는 칸들. stopped (그만둔 반복 id) 는 여기 들어가지 않습니다. */
const HW_BUCKETS = ['all', '0', '1', '2', '3', '4', '5', '6'];
const hwRepeatCount = r => !r ? 0 : HW_BUCKETS.reduce((n, k) => n + ((r[k] || []).length), 0);

/** 기기에 있던 틀과 드라이브에서 받은 틀을 합칩니다.
    드라이브 쪽을 기본으로 하되, 기기에만 있는 것은 살려 둡니다.
    (저장이 한 번 실패해도 반복이 조용히 사라지지 않게 하려는 것입니다.
     단, 다른 기기에서 '반복 그만하기' 한 것은 stopped 에 적혀 있으므로 되살리지 않습니다.) */
function hwRepeatMerge(local, remote) {
  const out = { ...(remote || {}) };
  const stopped = new Set(out.stopped || []);
  if (!local) return out;
  for (const k of HW_BUCKETS) {
    const mine = local[k] || [];
    if (!mine.length) continue;
    const have = out[k] = [...(out[k] || [])];
    for (const r of mine) {
      if (stopped.has(r.id)) continue;
      if (!have.some(x => x.id === r.id)) have.push(r);
    }
  }
  return out;
}

/** 틀을 잃어버렸을 때 그 주에 남아 있는 반복 항목으로 되살립니다.
    (틀만 날아가고 그 주 복사본은 남는 경우가 있어서, 그때 반복이 이번 주에만 보입니다.)
    되살린 게 있으면 true. 지난 주는 건드리지 않습니다. */
function hwHealRepeat(mon) {
  if (!hwData) return false;
  const thisMon = ymd(startOfWeek(new Date(), CFG.WEEK_START));
  if (mon < thisMon) return false;                    // 지난 주에서는 되살리지 않습니다

  hwRepeat = hwRepeat || {};
  const stopped = new Set(hwRepeat.stopped || []);
  const known = new Set();
  for (const k of HW_BUCKETS) for (const r of (hwRepeat[k] || [])) known.add(r.id);

  const seen = new Map();                             // 잃어버린 반복 id → { text, days:Set(요일) }
  for (let i = 0; i < 7; i++) {
    const d = addDays(parseYmd(mon), i), ds = ymd(d);
    for (const t of (hwData.days[ds] || [])) {
      if (!t.rep || known.has(t.rep) || stopped.has(t.rep)) continue;
      const e = seen.get(t.rep) || { text: t.text, days: new Set() };
      e.days.add(d.getDay());
      seen.set(t.rep, e);
    }
  }
  if (!seen.size) return false;

  for (const [rid, e] of seen) {
    // 여러 요일에 흩어져 있으면 매일 반복이던 것입니다
    const k = e.days.size > 1 ? 'all' : String([...e.days][0]);
    (hwRepeat[k] = hwRepeat[k] || []).push({ id: rid, text: e.text });
  }
  return true;
}

/** 반복 목록에 있는데 그 주에 아직 없는 것을 채워 넣습니다. 채운 게 있으면 true */
function hwMaterialize(mon) {
  if (!hwData || !hwRepeat) return false;
  hwData.hide = hwData.hide || {};
  const start = parseYmd(mon);
  let added = false;
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i), ds = ymd(d);
    const list = hwRepeatFor(d);
    if (!list.length) continue;
    const have = hwData.days[ds] || (hwData.days[ds] = []);
    const off = hwData.hide[ds] || [];
    for (const r of list) {
      if (have.some(x => x.rep === r.id)) continue;      // 이미 들어와 있음
      if (off.includes(r.id)) continue;                  // 이번 주에 빼 둔 것
      have.push({ id: hwUid(), text: r.text, done: false, rep: r.id });
      added = true;
    }
  }
  return added;
}

/** 그만둔 반복이 이미 찍혀 있던 주에서도 빠지게 합니다.
    앞으로의 주만 손봅니다 — 지난 주는 그때 한 기록이라 그대로 둡니다.
    뺀 게 있으면 true */
function hwStripStopped(mon) {
  if (!hwData || !hwRepeat) return false;
  const stopped = new Set(hwRepeat.stopped || []);
  if (!stopped.size) return false;
  if (mon < ymd(startOfWeek(new Date(), CFG.WEEK_START))) return false;

  let cut = false;
  for (const ds of Object.keys(hwData.days)) {
    const list = hwData.days[ds] || [];
    const kept = list.filter(t => !(t.rep && stopped.has(t.rep)));
    if (kept.length !== list.length) { hwData.days[ds] = kept; cut = true; }
  }
  return cut;
}

/** 그 날에서 이 반복 항목을 빼 둡니다 (다시 열어도 되살아나지 않게) */
function hwHide(ds, repId) {
  if (!repId) return;
  hwData.hide = hwData.hide || {};
  const off = hwData.hide[ds] || (hwData.hide[ds] = []);
  if (!off.includes(repId)) off.push(repId);
}

/** 반복 틀에서 그 id 가 어느 칸에 있는지 ('all' 또는 '0'~'6') */
function hwRepeatBucket(repId) {
  if (!hwRepeat) return null;
  for (const k of HW_BUCKETS) {
    if ((hwRepeat[k] || []).some(x => x.id === repId)) return k;
  }
  return null;
}

/* ---------- 화면 ---------- */

function renderHw(mon) {
  const box = $('#hw');
  if (!box) return;
  box.hidden = !HW_ON;
  if (!HW_ON) return;

  const monStr = ymd(mon);
  const fresh = (monStr !== hwWeek);
  if (fresh) {
    hwFlush();                                     // 보던 주를 먼저 저장
    hwWeek = monStr;
    const c = localStorage.getItem('planner.hw.w.' + monStr);
    hwData = c ? JSON.parse(c) : emptyHw();
    const r = localStorage.getItem('planner.hw.repeat');
    hwRepeat = r ? JSON.parse(r) : null;
    if (hwRepeat) { hwStripStopped(monStr); hwMaterialize(monStr); }
  }

  const today = new Date();
  $('#hw-grid').innerHTML = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(mon, i), ds = ymd(d);
    const list = (hwData.days[ds] || []);
    return `<div class="hwcol ${dayKind(d)} ${sameDay(d, today) ? 'is-today' : ''}" data-date="${ds}">
        <div class="hwday"><b>${DOW_KR[d.getDay()]}</b><span>${d.getDate()}</span></div>
        <div class="hwlist" data-date="${ds}">${
          list.map(t => `<div class="hwitem${t.done ? ' done' : ''}" data-id="${t.id}">
              <span class="hwgrip" aria-hidden="true"></span>
              <button class="hwbox" data-act="toggle" aria-label="끝냄 표시">✓</button>
              <button class="hwtext" data-act="edit">${esc(t.text)}${
                t.rep ? `<i class="hwrep" title="${
                  hwRepeatBucket(t.rep) === 'all' ? '매일 반복' : '매주 반복'}">🔁</i>` : ''}</button>
            </div>`).join('')
        }</div>
        <button class="hwadd" data-add="${ds}">+ 추가</button>
      </div>`;
  }).join('');

  if (fresh) {
    guard(async () => {
      const [wk, rp] = await Promise.all([hwFetchWeek(monStr), hwFetchRepeat()]);
      if (hwWeek !== monStr) return;               // 그 사이 주를 옮겼으면 버립니다
      hwData = wk;
      // 드라이브 쪽이 비어 있다고 기기에 있던 틀을 지우지 않습니다 (반복이 사라지는 일을 막습니다)
      hwRepeat = hwRepeatMerge(hwRepeat, rp);
      // 틀은 잃었는데 그 주에 반복 항목이 남아 있으면 틀을 되살립니다
      const healed = hwHealRepeat(monStr);
      const lost = healed || hwRepeatCount(hwRepeat) > hwRepeatCount(rp);
      localStorage.setItem('planner.hw.repeat', JSON.stringify(hwRepeat));
      const cut = hwStripStopped(monStr);          // 그만둔 반복이 남아 있으면 치웁니다
      const added = hwMaterialize(monStr);
      localStorage.setItem('planner.hw.w.' + monStr, JSON.stringify(hwData));
      if (state.view === 'week') renderHw(parseYmd(monStr));
      if (added || cut) hwTouch();                 // 새로 찍어낸 것 · 치운 것을 저장해 둡니다
      if (lost) hwSaveRepeat();                    // 드라이브 쪽 틀을 다시 채워 둡니다
    }, '아이 할 일 불러오는 중…');
  }
}

/* ---------- 저장 ---------- */

function hwTouch() {
  clearTimeout(hwTimer);
  setSync('작성 중…');
  hwTimer = setTimeout(hwSave, 900);
}

function hwFlush() { if (hwTimer) { clearTimeout(hwTimer); hwTimer = 0; hwSave(); } }

async function hwSave() {
  clearTimeout(hwTimer); hwTimer = 0;
  if (!hwWeek || !hwData) return;
  if (hwSaving) { hwAgain = true; return; }
  const mon = hwWeek;
  hwSaving = true;
  try {
    setSync('저장 중…', 'busy');
    await hwPutWeek(mon, hwData);
    localStorage.setItem('planner.hw.w.' + mon, JSON.stringify(hwData));
    setSync('저장됨');
    setTimeout(() => { if (!hwTimer && state.view === 'week') setSync(''); }, 1500);
  } catch (e) {
    console.error(e);
    const off = e.message === 'drive_off';
    setSync(off ? '드라이브 설정 필요' : '저장 실패', 'err');
    toast(off ? '구글 클라우드에서 Google Drive API 를 켜야 합니다 (설정가이드 참고)'
              : '아이 할 일을 저장하지 못했습니다. 잠시 뒤 다시 시도합니다');
    if (!off) hwTimer = setTimeout(hwSave, 8000);
  } finally {
    hwSaving = false;
    if (hwAgain) { hwAgain = false; hwSave(); }
  }
}

let hwRepTimer = 0;

/** 반복 틀을 저장합니다.
    기기에 먼저 적어 두고 올립니다 — 올리다 실패해도 반복이 사라지지 않게 하려는 것입니다.
    실패하면 잠시 뒤 다시 시도합니다. */
async function hwSaveRepeat() {
  clearTimeout(hwRepTimer); hwRepTimer = 0;
  const data = hwRepeat || {};
  localStorage.setItem('planner.hw.repeat', JSON.stringify(data));
  try {
    await hwPutRepeat(data);
  } catch (e) {
    console.error(e);
    if (e.message === 'drive_off') {
      setSync('드라이브 설정 필요', 'err');
      toast('구글 클라우드에서 Google Drive API 를 켜야 합니다 (설정가이드 참고)');
      return;
    }
    setSync('반복 저장 실패', 'err');
    toast('반복 설정을 저장하지 못했습니다. 잠시 뒤 다시 시도합니다');
    hwRepTimer = setTimeout(hwSaveRepeat, 8000);
  }
}

/* ---------- 넣고 고치기 ---------- */

let hwEditing = null;      // { ds, id } — 고치는 중이면 채워집니다

function openHwSheet(ds, id) {
  const item = id ? (hwData.days[ds] || []).find(t => t.id === id) : null;
  hwEditing = item ? { ds, id } : { ds, id: null };

  const d = parseYmd(ds);
  $('#hw-title').textContent = item ? '할 일 고치기' : '할 일 추가';
  $('#hw-when').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_KR[d.getDay()]})`;
  $('#hw-text').value = item ? item.text : '';

  /* 반복 — 이미 반복으로 들어온 것은 무엇이었는지 보여만 줍니다 (지울 때 묻습니다) */
  const bucket = item && item.rep ? hwRepeatBucket(item.rep) : null;
  const sel = $('#hw-rep-mode');
  sel.innerHTML =
    '<option value="">반복 안 함</option>' +
    `<option value="week">매주 ${DOW_KR[d.getDay()]}요일마다</option>` +
    '<option value="day">매일</option>';
  sel.value = bucket === 'all' ? 'day' : bucket ? 'week' : '';
  sel.disabled = !!bucket;
  $('#hw-rep-note').hidden = !bucket;
  if (bucket) $('#hw-rep-note').textContent =
    (bucket === 'all' ? '매일' : `매주 ${DOW_KR[d.getDay()]}요일마다`) +
    ' 반복 중입니다. 반복을 그만두려면 아래에서 지우세요.';
  $('#hw-del').hidden = !item;

  $('#hwsheet').hidden = false;
  setTimeout(() => $('#hw-text').focus(), 60);
}

function closeHwSheet() { $('#hwsheet').hidden = true; hwEditing = null; }

async function saveHwSheet() {
  const text = $('#hw-text').value.trim();
  if (!text) { toast('내용을 입력해 주세요'); return; }
  const { ds, id } = hwEditing;
  const mode = $('#hw-rep-mode').disabled ? '' : $('#hw-rep-mode').value;
  closeHwSheet();

  const list = hwData.days[ds] || (hwData.days[ds] = []);
  if (id) {
    const item = list.find(t => t.id === id);
    if (item) item.text = text;
    // 반복으로 들어온 것은 틀의 내용도 함께 고칩니다
    if (item && item.rep && hwRepeat) {
      const k = hwRepeatBucket(item.rep);
      const r = k && (hwRepeat[k] || []).find(x => x.id === item.rep);
      if (r) { r.text = text; await hwSaveRepeat(); }
    }
  } else if (mode) {
    // 반복 — 틀에 넣고, 이번 주에도 한 벌 찍어냅니다
    const k = (mode === 'day') ? 'all' : String(parseYmd(ds).getDay());
    hwRepeat = hwRepeat || {};
    const rid = hwUid();
    (hwRepeat[k] = hwRepeat[k] || []).push({ id: rid, text });
    list.push({ id: hwUid(), text, done: false, rep: rid });
    await hwSaveRepeat();
    // 매일 반복이면 이번 주 나머지 날에도 바로 채웁니다
    if (k === 'all') hwMaterialize(hwWeek);
  } else {
    list.push({ id: hwUid(), text, done: false });
  }
  renderHw(parseYmd(hwWeek));
  hwTouch();
}

/** 지우기 — 반복으로 들어온 것은 범위를 묻습니다 */
async function deleteHwItem(ds, id) {
  const list = hwData.days[ds] || [];
  const item = list.find(t => t.id === id);
  if (!item) return;

  let alsoRepeat = false;
  const bucket = item.rep ? hwRepeatBucket(item.rep) : null;
  if (item.rep) {
    const pick = await askHwScope(bucket === 'all' ? '매일' : '매주');
    if (!pick) return;
    alsoRepeat = (pick === 'all');
  } else if (!confirm('이 할 일을 지울까요?')) return;

  hwData.days[ds] = list.filter(t => t.id !== id);
  if (alsoRepeat && hwRepeat && bucket) {
    hwRepeat[bucket] = (hwRepeat[bucket] || []).filter(x => x.id !== item.rep);
    // 그만둔 것을 적어 둡니다 — 다른 기기에 남아 있던 틀 때문에 되살아나지 않게
    hwRepeat.stopped = [...(hwRepeat.stopped || []), item.rep].slice(-200);
    await hwSaveRepeat();
    // 매일 반복이면 이번 주 다른 날에 들어와 있는 것도 함께 치웁니다
    if (bucket === 'all') {
      for (const k of Object.keys(hwData.days))
        hwData.days[k] = (hwData.days[k] || []).filter(t => t.rep !== item.rep);
    }
  } else if (item.rep) {
    hwHide(ds, item.rep);          // 이번 주만 — 다시 열어도 되살아나지 않게
  }
  renderHw(parseYmd(hwWeek));
  hwTouch();
  toast(alsoRepeat ? '반복을 그만두었습니다' : '이번 주에서 지웠습니다');
}

/** '이번 주만' / '반복 그만' 을 묻습니다 */
function askHwScope(kind = '매주') {
  return new Promise(resolve => {
    const box = $('#hwscope');
    $('#hs-h').textContent = kind + ' 반복하는 할 일';
    $('#hs-all').textContent = kind + ' 반복 그만하기';
    box.hidden = false;
    const done = v => { box.hidden = true; box.onclick = null; resolve(v); };
    box.onclick = e => {
      const b = e.target.closest('[data-hs]');
      if (b) return done(b.dataset.hs || null);
      if (e.target.id === 'hwscope') done(null);
    };
  });
}

/* ---------- 끌어서 순서 바꾸기 ---------- */

function wireHwDrag() {
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

  $('#hw-grid').addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    const h = e.target.closest('.hwgrip');
    if (!h) return;
    const el = h.closest('.hwitem');
    if (!el) return;
    st = { el, id: el.dataset.id, from: el.closest('.hwlist').dataset.date,
           x: e.clientX, y: e.clientY, active: false, timer: null };
    // 손가락은 꾹 눌러야 시작합니다 (스크롤과 헷갈리지 않게)
    if (e.pointerType !== 'mouse') st.timer = setTimeout(() => { if (st) begin(); }, 260);
  });

  window.addEventListener('pointermove', e => {
    if (!st) return;
    if (!st.active) {
      if (Math.hypot(e.clientX - st.x, e.clientY - st.y) < 6) return;
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      if (e.pointerType !== 'mouse') { stop(); return; }   // 터치는 스크롤로 넘깁니다
      begin();
    }
    e.preventDefault();

    st.el.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    st.el.style.pointerEvents = '';
    if (!under) return;
    const list = under.closest('.hwlist') ||
                 (under.closest('.hwcol') ? under.closest('.hwcol').querySelector('.hwlist') : null);
    if (!list) return;

    const items = [...list.querySelectorAll('.hwitem')].filter(x => x !== st.el);
    let before = null;
    for (const it of items) {
      const r = it.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { before = it; break; }
    }
    list.insertBefore(st.el, before);
  }, { passive: false });

  window.addEventListener('pointerup', () => {
    if (!st || !st.active) return stop();
    const { el, id, from } = st;
    stop();

    const list = el.closest('.hwlist');
    const to = list.dataset.date;
    const order = [...list.querySelectorAll('.hwitem')].map(x => x.dataset.id);

    // 옮긴 곳 기준으로 목록을 다시 짭니다
    const moved = (hwData.days[from] || []).find(t => t.id === id);
    if (!moved) return;
    if (from !== to) hwData.days[from] = (hwData.days[from] || []).filter(t => t.id !== id);
    const pool = [...(hwData.days[to] || []).filter(t => t.id !== id), moved];
    hwData.days[to] = order.map(i => pool.find(t => t.id === i)).filter(Boolean);

    /* 다른 날로 옮겼으면 원래 날에서는 빼 둡니다.
       이게 없으면 다시 열 때 원래 날에 하나 더 찍혀 둘이 됩니다. */
    if (from !== to && moved.rep) hwHide(from, moved.rep);

    renderHw(parseYmd(hwWeek));
    hwTouch();
  });

  window.addEventListener('pointercancel', stop);
}

/* ---------- 연결 ---------- */

function wireHw() {
  const box = $('#hw');
  if (!box) return;                   // 예전 화면 파일이 남아 있어도 앱이 멈추지 않게

  $('#hw-grid').onclick = e => {
    if (dragBlockClick) return;
    const add = e.target.closest('[data-add]');
    if (add) return openHwSheet(add.dataset.add, null);
    const item = e.target.closest('.hwitem');
    if (!item) return;
    const ds = item.closest('.hwlist').dataset.date;
    const act = (e.target.closest('[data-act]') || {}).dataset;
    if (act && act.act === 'toggle') {
      const t = (hwData.days[ds] || []).find(x => x.id === item.dataset.id);
      if (t) { t.done = !t.done; item.classList.toggle('done', t.done); hwTouch(); }
      return;
    }
    if (act && act.act === 'edit') openHwSheet(ds, item.dataset.id);
  };

  $('#hw-cancel').onclick = closeHwSheet;
  $('#hwsheet').onclick = e => { if (e.target.id === 'hwsheet') closeHwSheet(); };
  $('#hw-save').onclick = saveHwSheet;
  $('#hw-text').addEventListener('keydown', e => { if (e.key === 'Enter') saveHwSheet(); });
  $('#hw-del').onclick = () => {
    const { ds, id } = hwEditing || {};
    closeHwSheet();
    if (id) deleteHwItem(ds, id);
  };

  wireHwDrag();
  window.addEventListener('beforeunload', () => { if (hwTimer) hwSave(); });

  /* 설정 — 보일지 말지 */
  $('#st-hw').onchange = e => {
    HW_ON = e.target.checked;
    localStorage.setItem('planner.hw.on', HW_ON ? '1' : '0');
    if (!HW_ON) hwFlush();
    hwWeek = '';                      // 다시 켜면 새로 불러오도록
    if (state.view === 'week') renderWeek();
  };
}
