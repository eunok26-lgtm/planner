/* ============================================================
   육아일기 — 날짜별로 한 장씩, 구글 드라이브에 저장합니다.

   왜 드라이브인가 : 사진·문서를 담아야 해서 캘린더나 Tasks 로는 안 됩니다.
   권한은 drive.file 하나만 쓰므로 이 앱이 만든 파일 말고
   드라이브의 다른 내용에는 접근하지 않습니다.

   저장 구조 (드라이브 안 "육아일기" 폴더)
     d-2026-08-20.json    그 날의 글 + 첨부 목록
     draw-2026-08-20.png  그 날 그린 그림
     a-2026-08-20-…       사진·문서 원본
   ============================================================ */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UP  = 'https://www.googleapis.com/upload/drive/v3';

let diaryDate  = null;          // 보고 있는 날짜 'YYYY-MM-DD'
let diaryMonth = null;          // 작은 달력이 펼쳐 놓은 달
let dEntry     = null;          // { text, draw, files:[{id,name,mime,size}] }
let dFolderId  = localStorage.getItem('planner.diary.folder') || '';
let dDays      = new Set(JSON.parse(localStorage.getItem('planner.diary.days') || '[]'));
let dFileIds   = JSON.parse(localStorage.getItem('planner.diary.ids') || '{}');   // ds → 드라이브 파일 id
let dSaveTimer = 0, dSaving = false, dAgain = false, dLoadedDs = null;
const dBlobs   = new Map();     // 파일 id → 화면에 띄울 주소 (이 세션 동안만)

const emptyEntry = () => ({ text: '', draw: '', files: [] });

/* ---------- 드라이브 호출 ---------- */

async function dfetch(url, opts = {}, retried = false) {
  const token = await ensureToken();
  const res = await fetch(url, {
    ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) }
  });
  if (res.status === 401 && !retried) { accessToken = null; return dfetch(url, opts, true); }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403 && /accessNotConfigured|has not been used/i.test(body))
      throw new Error('drive_off');
    throw new Error(res.status + ' ' + body.slice(0, 200));
  }
  return res;
}
const dJson = async (u, o) => (await dfetch(u, o)).json();

/** 드라이브에 파일을 올리거나 덮어씁니다. id 를 주면 덮어쓰기입니다. */
async function driveUpload({ id, name, mime, body, appProperties }) {
  const meta = {};
  if (name) meta.name = name;
  if (appProperties) meta.appProperties = appProperties;
  if (!id && dFolderId) meta.parents = [dFolderId];

  const bd = '----planner' + Math.random().toString(36).slice(2);
  const blob = new Blob([
    '--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(meta),
    '\r\n--' + bd + '\r\nContent-Type: ' + (mime || 'application/octet-stream') + '\r\n\r\n',
    body,
    '\r\n--' + bd + '--\r\n'
  ]);
  const url = DRIVE_UP + '/files' + (id ? '/' + id : '') +
              '?uploadType=multipart&fields=id,name,mimeType,size';
  return dJson(url, {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + bd },
    body: blob
  });
}

/** 파일 내용을 받아 화면에 띄울 수 있는 주소로 바꿉니다. */
async function driveBlobUrl(id) {
  if (dBlobs.has(id)) return dBlobs.get(id);
  const res = await dfetch(DRIVE_API + '/files/' + id + '?alt=media');
  const url = URL.createObjectURL(await res.blob());
  dBlobs.set(id, url);
  return url;
}

/** "육아일기" 폴더를 찾고, 없으면 만듭니다. */
async function diaryFolder() {
  if (dFolderId) return dFolderId;
  const name = (CFG.DIARY_FOLDER || '육아일기').replace(/'/g, "\\'");
  const q = "mimeType='application/vnd.google-apps.folder' and name='" + name + "' and trashed=false";
  const found = await dJson(DRIVE_API + '/files?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1');
  dFolderId = (found.files && found.files[0] && found.files[0].id) ||
    (await dJson(DRIVE_API + '/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: CFG.DIARY_FOLDER || '육아일기',
                             mimeType: 'application/vnd.google-apps.folder' })
    })).id;
  localStorage.setItem('planner.diary.folder', dFolderId);
  return dFolderId;
}

/** 일기를 쓴 날 목록 — 작은 달력에 점으로 표시합니다. */
async function diaryIndex() {
  await diaryFolder();
  const q = "'" + dFolderId + "' in parents and trashed=false and name contains 'd-'";
  const base = DRIVE_API + '/files?q=' + encodeURIComponent(q) +
               '&fields=nextPageToken,files(id,name)&pageSize=1000';
  const days = new Set(), ids = {};
  let token = '';
  for (let n = 0; n < 20; n++) {
    const j = await dJson(base + (token ? '&pageToken=' + token : ''));
    for (const f of j.files || []) {
      const m = /^d-(\d{4}-\d{2}-\d{2})\.json$/.exec(f.name);
      if (m) { days.add(m[1]); ids[m[1]] = f.id; }
    }
    if (!j.nextPageToken) break;
    token = j.nextPageToken;
  }
  dDays = days; dFileIds = ids;
  localStorage.setItem('planner.diary.days', JSON.stringify([...days]));
  localStorage.setItem('planner.diary.ids', JSON.stringify(ids));
}

/** 그 날의 일기를 읽어옵니다. 없으면 빈 일기입니다. */
async function diaryFetch(ds) {
  await diaryFolder();
  let id = dFileIds[ds];
  if (!id) {
    const q = "'" + dFolderId + "' in parents and trashed=false and name='d-" + ds + ".json'";
    const j = await dJson(DRIVE_API + '/files?q=' + encodeURIComponent(q) + '&fields=files(id)&pageSize=1');
    id = j.files && j.files[0] && j.files[0].id;
    if (id) { dFileIds[ds] = id; localStorage.setItem('planner.diary.ids', JSON.stringify(dFileIds)); }
  }
  if (!id) return emptyEntry();
  const e = await (await dfetch(DRIVE_API + '/files/' + id + '?alt=media')).json();
  return { ...emptyEntry(), ...e };
}

/** 그 날의 일기를 저장합니다. */
async function diaryPut(ds, entry) {
  await diaryFolder();
  const res = await driveUpload({
    id: dFileIds[ds], name: 'd-' + ds + '.json', mime: 'application/json',
    body: JSON.stringify(entry), appProperties: { planner: 'diary', day: ds }
  });
  dFileIds[ds] = res.id;
  dDays.add(ds);
  localStorage.setItem('planner.diary.ids', JSON.stringify(dFileIds));
  localStorage.setItem('planner.diary.days', JSON.stringify([...dDays]));
}

/* ---------- 그림판 ---------- */

const DRAW_COLORS = ['#3f4854', '#c4606c', '#5b7c99', '#7b9a6d', '#c98b3a'];
const dw = { ctx: null, pen: DRAW_COLORS[0], size: 3, erase: false,
             strokes: [], base: null, cur: null, dirty: false };

function dwRedraw() {
  const c = $('#dw-canvas'), ctx = dw.ctx;
  if (!ctx) return;
  const r = window.devicePixelRatio || 1;
  const w = c.width / r, h = c.height / r;
  ctx.setTransform(r, 0, 0, r, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (dw.base) ctx.drawImage(dw.base, 0, 0, w, h);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of dw.strokes) {
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.erase ? s.width * 5 : s.width;
    ctx.beginPath();
    s.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** 화면 폭에 맞춰 그림판 크기를 잡습니다 (선명하도록 화면 배율까지 반영). */
function dwSize() {
  const c = $('#dw-canvas');
  if (!c || !c.clientWidth) return;
  const r = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth), h = Math.round(w * 0.52);
  c.style.height = h + 'px';
  const pw = Math.round(w * r), ph = Math.round(h * r);
  if (c.width === pw && c.height === ph) return;
  c.width = pw; c.height = ph;
  dw.ctx = c.getContext('2d');
  dwRedraw();
}

function dwLoad(fileId) {
  dw.strokes = []; dw.base = null; dw.dirty = false; dw.cur = null;
  dwRedraw();
  if (!fileId) return;
  driveBlobUrl(fileId).then(url => {
    const img = new Image();
    img.onload = () => { dw.base = img; dwRedraw(); };
    img.src = url;
  }).catch(() => {});
}

/** 그린 게 있으면 PNG 로 만들어 돌려줍니다. 없으면 null. */
function dwBlob() {
  return new Promise(resolve => {
    if (!dw.strokes.length && !dw.base) return resolve(null);
    $('#dw-canvas').toBlob(b => resolve(b), 'image/png');
  });
}

function dwSyncTools() {
  $$('#dw-tools [data-c]').forEach(b =>
    b.classList.toggle('on', !dw.erase && b.dataset.c === dw.pen));
  $$('#dw-tools [data-w]').forEach(b => b.classList.toggle('on', +b.dataset.w === dw.size));
  $('#dw-erase').classList.toggle('on', dw.erase);
}

function wireDraw() {
  const c = $('#dw-canvas');
  const pt = e => {
    const r = c.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  c.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    c.setPointerCapture(e.pointerId);
    dw.cur = { color: dw.pen, width: dw.size, erase: dw.erase, pts: [pt(e)] };
    dw.strokes.push(dw.cur);
    dwRedraw();
  });
  c.addEventListener('pointermove', e => {
    if (!dw.cur) return;
    dw.cur.pts.push(pt(e));
    dwRedraw();
  });
  const end = () => {
    if (!dw.cur) return;
    dw.cur = null; dw.dirty = true; diaryTouch();
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('lostpointercapture', end);

  $('#dw-tools').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.c)       { dw.pen = b.dataset.c; dw.erase = false; }
    else if (b.dataset.w)  { dw.size = +b.dataset.w; dw.erase = false; }
    else if (b.id === 'dw-erase') dw.erase = !dw.erase;
    else if (b.id === 'dw-undo')  { if (dw.strokes.pop()) { dw.dirty = true; dwRedraw(); diaryTouch(); } }
    else if (b.id === 'dw-clear') {
      if (!dw.strokes.length && !dw.base) return;
      if (!confirm('그림을 모두 지울까요?')) return;
      dw.strokes = []; dw.base = null; dw.dirty = true; dwRedraw(); diaryTouch();
    }
    dwSyncTools();
  };
  dwSyncTools();
}

/* ---------- 화면 ---------- */

function diaryTitleOf(ds) {
  const d = parseYmd(ds);
  const label = holidayOf(d) || termOf(d) || '';
  return {
    big:   (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + DOW_KR[d.getDay()] + '요일',
    small: d.getFullYear() + '년' + (label ? ' · ' + label : ''),
    kind:  dayKind(d)
  };
}

function renderMiniCal() {
  const m = diaryMonth;
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const gs = startOfWeek(first, CFG.WEEK_START);
  const order = CFG.WEEK_START === 1 ? [1,2,3,4,5,6,0] : [0,1,2,3,4,5,6];
  const dim = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const lead = Math.round((first - gs) / 86400000);
  const cells = Math.ceil((lead + dim) / 7) * 7;
  const today = ymd(new Date());

  let h = '<div class="mc-top">' +
      '<button class="mc-nav" data-mc="-1" aria-label="이전 달">‹</button>' +
      '<strong>' + m.getFullYear() + '.' + pad2(m.getMonth() + 1) + '</strong>' +
      '<button class="mc-nav" data-mc="1" aria-label="다음 달">›</button>' +
    '</div><div class="mc-grid">';
  h += order.map(i =>
    '<span class="mc-dow ' + (i === 0 ? 'sun' : i === 6 ? 'sat' : '') + '">' + DOW_KR[i] + '</span>').join('');
  for (let i = 0; i < cells; i++) {
    const d = addDays(gs, i), ds = ymd(d);
    const cls = ['mc-d', dayKind(d)];
    if (d.getMonth() !== m.getMonth()) cls.push('out');
    if (ds === today)     cls.push('now');
    if (ds === diaryDate) cls.push('sel');
    if (dDays.has(ds))    cls.push('has');
    h += '<button class="' + cls.join(' ') + '" data-d="' + ds + '">' + d.getDate() + '</button>';
  }
  $('#minical').innerHTML = h + '</div>';
}

function renderDiaryHead() {
  const t = diaryTitleOf(diaryDate);
  $('#d-when').innerHTML =
    '<strong class="' + t.kind + '">' + t.big + '</strong>' +
    '<span>' + esc(t.small) + '</span>' +
    (diaryDate === ymd(new Date()) ? '<em class="d-todaytag">오늘</em>' : '');
  renderMiniCal();
}

const fileSize = n => !n ? '' :
  n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';

function docIcon(mime, name) {
  const e = String(name || '').split('.').pop().toLowerCase();
  if (String(mime).startsWith('video/')) return '🎬';
  if (String(mime).startsWith('audio/')) return '🎵';
  if (e === 'pdf') return '📕';
  if (['doc','docx','hwp','hwpx','txt','rtf'].includes(e)) return '📄';
  if (['xls','xlsx','csv'].includes(e)) return '📊';
  if (['ppt','pptx'].includes(e)) return '📽️';
  if (['zip','7z','rar'].includes(e)) return '🗜️';
  return '📎';
}

/** 첨부 목록 — 사진은 미리보기로, 문서는 이름표로 */
function renderAttach() {
  const box = $('#d-files');
  const list = (dEntry && dEntry.files) || [];
  box.innerHTML = list.map(f => {
    const img = String(f.mime || '').startsWith('image/');
    return '<div class="att' + (img ? ' att-img' : '') + '" data-id="' + f.id + '">' +
      (img
        ? '<img alt="' + esc(f.name) + '" data-src="' + f.id + '">'
        : '<div class="att-doc"><span class="att-ico">' + docIcon(f.mime, f.name) + '</span>' +
          '<span class="att-name">' + esc(f.name) + '</span>' +
          '<span class="att-size">' + fileSize(f.size) + '</span></div>') +
      '<button class="att-x" data-del="' + f.id + '" title="빼기">×</button></div>';
  }).join('');

  // 사진은 실제 내용을 받아와 보여줍니다
  box.querySelectorAll('img[data-src]').forEach(el => {
    driveBlobUrl(el.dataset.src)
      .then(u => { el.src = u; })
      .catch(() => { el.closest('.att').classList.add('att-fail'); });
  });
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.max(140, el.scrollHeight) + 'px';
}

function renderDiary() {
  if (!diaryDate)  diaryDate = ymd(new Date());
  if (!diaryMonth) diaryMonth = parseYmd(diaryDate);
  $('#title').textContent = '육아일기';
  $('#subtitle').textContent = '';
  renderDiaryHead();
  $('#d-text').value = (dEntry && dEntry.text) || '';
  autoGrow($('#d-text'));
  renderAttach();
  requestAnimationFrame(dwSize);
}

/* ---------- 열기 · 저장 ---------- */

/** 그 날 페이지를 엽니다. 적어둔 게 있으면 채워서, 없으면 빈 종이로. */
function openDiary(ds) {
  dSaveFlush();                                   // 보던 날짜를 먼저 저장
  diaryDate = ds;
  diaryMonth = parseYmd(ds);

  const cached = localStorage.getItem('planner.diary.day.' + ds);
  dEntry = cached ? JSON.parse(cached) : emptyEntry();
  dLoadedDs = null;
  renderDiary();
  dwLoad(dEntry.draw);

  guard(async () => {
    const e = await diaryFetch(ds);
    if (diaryDate !== ds) return;                 // 그 사이 날짜를 옮겼으면 버립니다
    dEntry = e; dLoadedDs = ds;
    localStorage.setItem('planner.diary.day.' + ds, JSON.stringify(e));
    renderDiary();
    dwLoad(e.draw);
  }, '일기 불러오는 중…');
}

/** 고쳐졌다고 표시하고, 잠시 뒤 저장합니다. */
function diaryTouch() {
  clearTimeout(dSaveTimer);
  setSync('작성 중…');
  dSaveTimer = setTimeout(dSaveNow, 1200);
}

function dSaveFlush() {
  if (dSaveTimer) { clearTimeout(dSaveTimer); dSaveTimer = 0; dSaveNow(); }
}

async function dSaveNow() {
  clearTimeout(dSaveTimer); dSaveTimer = 0;
  if (!diaryDate || !dEntry) return;
  // 앞선 저장이 아직 안 끝났으면(사진 올리는 중 등) 끝난 뒤 한 번 더 저장합니다.
  // 그냥 건너뛰면 그 사이에 쓴 글이 사라집니다.
  if (dSaving) { dAgain = true; return; }
  const ds = diaryDate;
  dSaving = true;
  try {
    setSync('저장 중…', 'busy');
    if (state.view === 'diary') dEntry.text = $('#d-text').value;

    if (dw.dirty) {
      const blob = await dwBlob();
      if (blob) {
        const up = await driveUpload({
          id: dEntry.draw || undefined, name: 'draw-' + ds + '.png', mime: 'image/png',
          body: blob, appProperties: { planner: 'diarydraw', day: ds }
        });
        dEntry.draw = up.id;
        dBlobs.delete(up.id);
      } else if (dEntry.draw) {
        try { await dfetch(DRIVE_API + '/files/' + dEntry.draw, { method: 'DELETE' }); } catch (_) {}
        dEntry.draw = '';
      }
      dw.dirty = false;
    }

    await diaryPut(ds, dEntry);
    localStorage.setItem('planner.diary.day.' + ds, JSON.stringify(dEntry));
    renderMiniCal();
    setSync('저장됨');
    setTimeout(() => { if (state.view === 'diary' && !dSaveTimer) setSync(''); }, 1500);
  } catch (e) {
    console.error(e);
    const off = e.message === 'drive_off';
    setSync(off ? '드라이브 설정 필요' : '저장 실패', 'err');
    toast(off
      ? '구글 클라우드에서 Google Drive API 를 켜야 합니다 (설정가이드 참고)'
      : '일기를 저장하지 못했습니다. 잠시 뒤 다시 시도합니다');
    if (!off) dSaveTimer = setTimeout(dSaveNow, 8000);
  } finally {
    dSaving = false;
    if (dAgain) { dAgain = false; dSaveNow(); }
  }
}

/* ---------- 사진 · 문서 붙이기 ---------- */

const MAX_ATTACH = 50 * 1024 * 1024;

async function addDiaryFiles(files) {
  const list = [...files].filter(Boolean);
  if (!list.length || !diaryDate || !dEntry) return;
  const ds = diaryDate;
  const big = list.find(f => f.size > MAX_ATTACH);
  if (big) toast(big.name + ' 은(는) 50MB 가 넘어 건너뜁니다');

  await guard(async () => {
    await diaryFolder();
    let n = 0;
    for (const f of list) {
      if (f.size > MAX_ATTACH) continue;
      setSync('올리는 중 ' + (++n) + '/' + list.length + '…', 'busy');
      const up = await driveUpload({
        name: 'a-' + ds + '-' + Date.now() + '-' + f.name,
        mime: f.type || 'application/octet-stream',
        body: f,
        appProperties: { planner: 'diaryfile', day: ds }
      });
      if (diaryDate !== ds) return;
      dEntry.files.push({ id: up.id, name: f.name, mime: f.type || '',
                          size: Number(up.size || f.size || 0) });
      renderAttach();
    }
    await dSaveNow();
  }, '올리는 중…');
}

async function removeDiaryFile(id) {
  if (!confirm('이 첨부를 뺄까요?')) return;
  dEntry.files = dEntry.files.filter(f => f.id !== id);
  renderAttach();
  await guard(async () => {
    try { await dfetch(DRIVE_API + '/files/' + id, { method: 'DELETE' }); } catch (_) {}
    dBlobs.delete(id);
    await dSaveNow();
  }, '지우는 중…');
}

/** 사진은 크게 보고, 문서는 내려받습니다. */
async function openAttachment(f) {
  if (String(f.mime || '').startsWith('image/')) {
    $('#dview').hidden = false;
    $('#dv-img').removeAttribute('src');
    $('#dv-name').textContent = f.name;
    try { $('#dv-img').src = await driveBlobUrl(f.id); }
    catch (_) { toast('사진을 불러오지 못했습니다'); }
    return;
  }
  try {
    const url = await driveBlobUrl(f.id);
    const a = document.createElement('a');
    a.href = url; a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
  } catch (_) { toast('파일을 불러오지 못했습니다'); }
}

/* ---------- 연결 ---------- */

const hasFiles = e => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');

function wireDiary() {
  const view = $('#view-diary');

  $('#minical').onclick = e => {
    const nav = e.target.closest('[data-mc]');
    if (nav) {
      diaryMonth = new Date(diaryMonth.getFullYear(), diaryMonth.getMonth() + (+nav.dataset.mc), 1);
      return renderMiniCal();
    }
    const d = e.target.closest('[data-d]');
    if (d) openDiary(d.dataset.d);
  };

  $('#d-text').addEventListener('input', e => { autoGrow(e.target); diaryTouch(); });
  $('#d-text').addEventListener('blur', dSaveFlush);

  $('#d-pick').onclick   = () => $('#d-input').click();
  $('#d-input').onchange = e => { addDiaryFiles(e.target.files); e.target.value = ''; };

  $('#d-files').onclick = e => {
    const x = e.target.closest('[data-del]');
    if (x) return removeDiaryFile(x.dataset.del);
    const att = e.target.closest('.att');
    if (!att) return;
    const f = ((dEntry && dEntry.files) || []).find(v => v.id === att.dataset.id);
    if (f) openAttachment(f);
  };

  /* 파일 탐색기에서 끌어다 놓기 */
  let depth = 0;
  const dz = $('#d-drop');
  view.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth++; dz.classList.add('on');
  });
  view.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; dz.classList.add('on');
  });
  view.addEventListener('dragleave', () => {
    if (--depth <= 0) { depth = 0; dz.classList.remove('on'); }
  });
  view.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; dz.classList.remove('on');
    addDiaryFiles(e.dataTransfer.files);
  });
  /* 창 아무 데나 떨어뜨려도 브라우저가 그 파일을 열어버리지 않게 */
  ['dragover', 'drop'].forEach(t =>
    window.addEventListener(t, e => { if (hasFiles(e)) e.preventDefault(); }));

  /* 복사해 온 사진을 붙여넣기로도 넣을 수 있게 */
  view.addEventListener('paste', e => {
    const fs = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (fs.length) { e.preventDefault(); addDiaryFiles(fs); }
  });

  $('#dv-close').onclick = () => { $('#dview').hidden = true; };
  $('#dview').onclick = e => { if (e.target.id === 'dview') $('#dview').hidden = true; };

  wireDraw();
  window.addEventListener('resize', () => { if (state.view === 'diary') dwSize(); });
  window.addEventListener('beforeunload', () => { if (dSaveTimer) dSaveNow(); });
}

/** 일기 화면으로 들어올 때 */
function enterDiary() {
  if (!diaryDate) diaryDate = ymd(new Date());
  guard(async () => { await diaryIndex(); renderMiniCal(); }, '일기 목록 확인 중…');
  openDiary(diaryDate);
}

/** ‹ › 로 하루씩 이동 */
function shiftDiary(dir) { openDiary(ymd(addDays(parseYmd(diaryDate), dir))); }
