/* ============================================================
   주간 식단 — 위클리 아래에 붙는 작은 칸

   요일마다 그 날 메뉴와 메모를 적습니다.
   한 주에 파일 하나로, 구글 드라이브의 "플래너 식단" 폴더에 담깁니다.
     week-2026-10-05.json   그 주(월요일 기준) 7일치

   보일지 말지는 ⋯ → 설정 에서 켜고 끕니다. 그 선택은 기기에 남습니다.
   드라이브 호출은 육아일기에서 쓰는 것을 그대로 함께 씁니다.
   ============================================================ */

let MEAL_ON = localStorage.getItem('planner.meal.on') === '1';

let mealFolderId = localStorage.getItem('planner.meal.folder') || '';
let mealWeek = '';            // 지금 화면에 올라와 있는 주 (월요일 'YYYY-MM-DD')
let mealData = null;          // { days: { 'YYYY-MM-DD': { menu, note } } }
let mealTimer = 0, mealSaving = false, mealAgain = false;

const emptyMeal = () => ({ days: {} });
const mealKey = mon => 'week-' + mon + '.json';

/* ---------- 드라이브 ---------- */

/** "플래너 식단" 폴더를 찾고, 없으면 만듭니다. */
async function mealFolder() {
  if (mealFolderId) return mealFolderId;
  const name = (CFG.MEAL_FOLDER || '플래너 식단');
  const q = "mimeType='application/vnd.google-apps.folder' and name='" +
            name.replace(/'/g, "\\'") + "' and trashed=false";
  const found = await dJson(DRIVE_API + '/files?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1');
  mealFolderId = (found.files && found.files[0] && found.files[0].id) ||
    (await dJson(DRIVE_API + '/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
    })).id;
  localStorage.setItem('planner.meal.folder', mealFolderId);
  return mealFolderId;
}

let mealFileIds = JSON.parse(localStorage.getItem('planner.meal.ids') || '{}');   // 주 → 파일 id

async function mealFetch(mon) {
  await mealFolder();
  let id = mealFileIds[mon];
  if (!id) {
    const q = "'" + mealFolderId + "' in parents and trashed=false and name='" + mealKey(mon) + "'";
    const j = await dJson(DRIVE_API + '/files?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1');
    id = j.files && j.files[0] && j.files[0].id;
    if (id) { mealFileIds[mon] = id; localStorage.setItem('planner.meal.ids', JSON.stringify(mealFileIds)); }
  }
  if (!id) return emptyMeal();
  const e = await (await dfetch(DRIVE_API + '/files/' + id + '?alt=media')).json();
  return { ...emptyMeal(), ...e };
}

async function mealPut(mon, data) {
  await mealFolder();
  const res = await driveUpload({
    id: mealFileIds[mon], name: mealKey(mon), mime: 'application/json',
    parent: mealFolderId, body: JSON.stringify(data),
    appProperties: { planner: 'meal', week: mon }
  });
  mealFileIds[mon] = res.id;
  localStorage.setItem('planner.meal.ids', JSON.stringify(mealFileIds));
}

/* ---------- 화면 ---------- */

/** 그 주의 식단 칸을 그립니다. 위클리를 그릴 때마다 불립니다. */
function renderMeal(mon) {
  const box = $('#meal');
  if (!box) return;
  box.hidden = !MEAL_ON;
  if (!MEAL_ON) return;

  const monStr = ymd(mon);
  const fresh = (monStr !== mealWeek);
  if (fresh) {
    mealFlush();                                   // 보던 주를 먼저 저장
    mealWeek = monStr;
    const cached = localStorage.getItem('planner.meal.w.' + monStr);
    mealData = cached ? JSON.parse(cached) : emptyMeal();
  }

  const today = new Date();
  $('#meal-grid').innerHTML = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(mon, i), ds = ymd(d);
    const v = mealData.days[ds] || {};
    return `<div class="mcol ${dayKind(d)} ${sameDay(d, today) ? 'is-today' : ''}" data-date="${ds}">
        <div class="mday"><b>${DOW_KR[d.getDay()]}</b><span>${d.getDate()}</span></div>
        <textarea class="mmenu" data-date="${ds}" rows="2"
                  placeholder="메뉴">${esc(v.menu || '')}</textarea>
        <input class="mnote" data-date="${ds}" type="text"
               placeholder="메모" value="${esc(v.note || '')}">
      </div>`;
  }).join('');

  if (fresh) {
    guard(async () => {
      const got = await mealFetch(monStr);
      if (mealWeek !== monStr) return;             // 그 사이 주를 옮겼으면 버립니다
      mealData = got;
      localStorage.setItem('planner.meal.w.' + monStr, JSON.stringify(got));
      if (state.view === 'week') renderMeal(parseYmd(monStr));
    }, '식단 불러오는 중…');
  }
}

/* ---------- 저장 ---------- */

function mealTouch() {
  clearTimeout(mealTimer);
  setSync('작성 중…');
  mealTimer = setTimeout(mealSave, 1200);
}

function mealFlush() { if (mealTimer) { clearTimeout(mealTimer); mealTimer = 0; mealSave(); } }

async function mealSave() {
  clearTimeout(mealTimer); mealTimer = 0;
  if (!mealWeek || !mealData) return;
  // 앞선 저장이 아직이면 끝난 뒤 한 번 더 (그 사이에 적은 것이 사라지지 않게)
  if (mealSaving) { mealAgain = true; return; }
  const mon = mealWeek;
  mealSaving = true;
  try {
    setSync('저장 중…', 'busy');
    await mealPut(mon, mealData);
    localStorage.setItem('planner.meal.w.' + mon, JSON.stringify(mealData));
    setSync('저장됨');
    setTimeout(() => { if (!mealTimer && state.view === 'week') setSync(''); }, 1500);
  } catch (e) {
    console.error(e);
    const off = e.message === 'drive_off';
    setSync(off ? '드라이브 설정 필요' : '저장 실패', 'err');
    toast(off ? '구글 클라우드에서 Google Drive API 를 켜야 합니다 (설정가이드 참고)'
              : '식단을 저장하지 못했습니다. 잠시 뒤 다시 시도합니다');
    if (!off) mealTimer = setTimeout(mealSave, 8000);
  } finally {
    mealSaving = false;
    if (mealAgain) { mealAgain = false; mealSave(); }
  }
}

/** 칸에 적은 내용을 담아 둡니다 */
function mealEdit(ds, field, value) {
  if (!mealData) mealData = emptyMeal();
  const row = mealData.days[ds] || (mealData.days[ds] = { menu: '', note: '' });
  row[field] = value;
  if (!row.menu && !row.note) delete mealData.days[ds];   // 빈 날은 담아두지 않습니다
  mealTouch();
}

/* ---------- 연결 ---------- */

function wireMeal() {
  const box = $('#meal');
  if (!box) return;                   // 예전 화면 파일이 남아 있어도 앱이 멈추지 않게

  $('#meal-grid').addEventListener('input', e => {
    const el = e.target;
    if (el.classList.contains('mmenu')) mealEdit(el.dataset.date, 'menu', el.value);
    else if (el.classList.contains('mnote')) mealEdit(el.dataset.date, 'note', el.value);
  });
  $('#meal-grid').addEventListener('focusout', mealFlush);
  window.addEventListener('beforeunload', () => { if (mealTimer) mealSave(); });

  /* 설정 — 보일지 말지 */
  $('#mi-settings').onclick = () => {
    $('#menu').hidden = true;
    $('#st-meal').checked = MEAL_ON;
    $('#setsheet').hidden = false;
  };
  $('#st-close').onclick = () => { $('#setsheet').hidden = true; };
  $('#setsheet').onclick = e => { if (e.target.id === 'setsheet') $('#setsheet').hidden = true; };
  $('#st-meal').onchange = e => {
    MEAL_ON = e.target.checked;
    localStorage.setItem('planner.meal.on', MEAL_ON ? '1' : '0');
    if (!MEAL_ON) mealFlush();
    mealWeek = '';                    // 다시 켜면 새로 불러오도록
    if (state.view === 'week') renderWeek();
  };
}
