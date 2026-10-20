/* ============================================================
   아이 일정 — 습관 앱의 "내 일정" 화면을 여기서도 보는 탭

   습관 앱은 구글 캘린더 "우리딸일정"과 "하교시간"을 읽어 그립니다.
   플래너는 그 두 캘린더를 이미 분류로 들고 있으므로,
   중계 서버 없이 같은 자료로 같은 화면을 그립니다.
   아이 기기에서 넣든 여기서 넣든 바로 함께 보입니다.

   보여주는 것 (습관 앱 기본 위젯 세 가지와 같습니다)
     🔔 하교 시각   오늘 학교가 끝나는 시각
     📌 오늘 일정   하교 후 학원·약속
     📅 이번 주     월~일 한눈에

   시간표·준비물·D-Day 같은 위젯은 아이 기기 안에만 있어
   여기서는 보여줄 수 없습니다.
   ============================================================ */

const KID_CAL     = () => CFG.KID_CAL || '우리딸일정';
const KID_DISMISS = () => CFG.KID_DISMISS_CAL || '하교시간';

/* 제목만 보고 어울리는 그림을 고릅니다 (습관 앱과 같은 표) */
const KID_ICONS = [
  [/태권도|합기도|검도|유도/, '🥋'], [/피아노|바이올린|첼로|악기|음악/, '🎹'],
  [/수영/, '🏊'], [/축구|풋살|농구|야구/, '⚽'], [/발레|무용|댄스/, '🩰'],
  [/미술|그림|드로잉|만들기/, '🎨'], [/영어/, '🔤'], [/수학|학원|공부|학습|과외/, '📚'],
  [/독서|도서관|책/, '📖'], [/병원|치과|진료|검진/, '🏥'], [/생일|파티/, '🎂'],
  [/놀이터|공원|키즈|놀기/, '🛝'], [/코딩|컴퓨터|로봇/, '💻'], [/줄넘기|체육|운동/, '🤸'],
  [/할머니|할아버지|외갓집|가족/, '🏡'], [/교회|성당|절/, '⛪'], [/여행|캠핑/, '🏕️']
];
const kidIcon = t => (KID_ICONS.find(([re]) => re.test(t)) || [, '📌'])[1];

/** 제목 앞에 적힌 시각을 읽어냅니다 — "2:00 피아노" → 14:00 + "피아노"
    습관 앱과 같은 규칙입니다. 1~7시는 오후로 봅니다. */
function kidTitleTime(raw) {
  const m = String(raw).match(
    /^\s*(오전|오후|AM|PM)?\s*(\d{1,2})\s*[:시]\s*(\d{1,2})?\s*분?\s*(오전|오후|AM|PM)?\s*[-–~]?\s*(.*)$/i);
  if (!m) return null;
  const ap = String(m[1] || m[4] || '').toLowerCase();
  let h = Number(m[2]);
  const mi = Number(m[3] || 0);
  if (h > 23 || mi > 59) return null;
  if (ap === '오후' || ap === 'pm')      { if (h < 12) h += 12; }
  else if (ap === '오전' || ap === 'am') { if (h === 12) h = 0; }
  else if (h >= 1 && h <= 7)             { h += 12; }     // 1~7시는 오후
  return { hm: pad2(h) + ':' + pad2(mi), title: (m[5] || '').trim() || String(raw).trim() };
}

/** "14:00" → "오후 2:00" */
function kidAmPm(hm) {
  const [h, m] = hm.split(':').map(Number);
  const ap = h < 12 ? '오전' : '오후';
  const h12 = h % 12 || 12;
  return `${ap} ${h12}:${pad2(m)}`;
}

const kidMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + (m || 0); };

/** 그 날 아이 일정을 습관 앱과 같은 모양으로 정리합니다 */
function kidDay(ds) {
  const all = eventsOn(ds);
  const sched = [], bells = [];
  for (const e of all) {
    const name = e.cat || '';
    if (name !== KID_CAL() && name !== KID_DISMISS()) continue;
    // 시각은 일정 자체의 시각이 먼저, 없으면 제목 앞에 적힌 시각
    const picked = kidTitleTime(e.text);
    const hm = e.time || (picked ? picked.hm : null);
    const title = (picked && !e.time) ? picked.title : e.text;
    if (name === KID_DISMISS()) { if (hm) bells.push(hm); continue; }
    sched.push({ hm, title, icon: kidIcon(title), allDay: !hm });
  }
  // 시간이 있는 것부터 시간 순서로, 하루 종일은 뒤에
  sched.sort((a, b) => (a.hm ? kidMin(a.hm) : 9999) - (b.hm ? kidMin(b.hm) : 9999));
  bells.sort();
  return { dismissal: bells[0] || null, events: sched };
}

/* ---------- 화면 ---------- */

function renderKid() {
  const today = new Date(), ds = ymd(today);
  $('#title').textContent = '아이 일정';
  $('#subtitle').textContent =
    `${today.getMonth() + 1}월 ${today.getDate()}일 (${DOW_KR[today.getDay()]})`;

  const d = kidDay(ds);
  const nowMin = today.getHours() * 60 + today.getMinutes();

  /* 🔔 하교 시각 */
  $('#kid-bell').innerHTML =
    `<div class="kb-lbl">오늘 학교는</div>
     <div class="kb-val">${d.dismissal ? kidAmPm(d.dismissal) + '에 끝나요' : '시간 정보가 없어요'}</div>`;

  /* 📌 오늘 일정 */
  const next = d.events.findIndex(e => e.hm && kidMin(e.hm) >= nowMin);
  $('#kid-today').innerHTML = d.events.length
    ? d.events.map((e, i) => {
        const past = e.hm && (next < 0 || i < next);
        return `<div class="kev${i === next ? ' next' : ''}${past ? ' past' : ''}">
            <span class="kev-t">${e.hm ? kidAmPm(e.hm).replace(' ', ' ') : '하루'}</span>
            <span class="kev-i">${e.icon}</span>
            <span class="kev-x">${esc(e.title)}${i === next ? '<em class="kev-tag">다음</em>' : ''}</span>
          </div>`;
      }).join('')
    : `<div class="kid-none"><b>🏠</b>오늘은 일정이 없어요.<br>집에서 푹 쉬어요!</div>`;

  /* 📅 이번 주 */
  const mon = startOfWeek(today, CFG.WEEK_START);
  $('#kid-week').innerHTML = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(mon, i), k = ymd(day);
    const w = kidDay(k);
    const wk = day.getDay() === 0 || day.getDay() === 6;
    return `<div class="kd${k === ds ? ' today' : ''}${wk ? ' wknd' : ''}">
        <div class="kd-h">
          <span class="kd-n">${DOW_KR[day.getDay()]}</span>
          <span class="kd-d">${day.getMonth() + 1}/${day.getDate()}</span>
          ${w.dismissal ? `<span class="kd-b">🔔 ${kidAmPm(w.dismissal)}</span>` : ''}
        </div>
        ${w.events.length
          ? w.events.map(e => `<div class="kd-e">
              <span class="kd-t">${e.hm ? kidAmPm(e.hm).replace(' ', ' ') : '하루'}</span>
              <span class="kd-x">${e.icon} ${esc(e.title)}</span></div>`).join('')
          : '<div class="kd-0">일정 없음</div>'}
      </div>`;
  }).join('');

  /* 분류가 아예 없으면 왜 비었는지 알려줍니다 */
  const have = WCATS.some(c => c.name === KID_CAL() || c.name === KID_DISMISS());
  $('#kid-warn').hidden = have;
  if (!have) $('#kid-warn').textContent =
    `"${KID_CAL()}" 와 "${KID_DISMISS()}" 분류를 찾지 못했습니다. ` +
    `⋯ → 표시할 캘린더 에서 그 캘린더가 있는지 확인해 주세요.`;
}

function wireKid() {
  const view = $('#view-kid');
  if (!view) return;         // 예전 화면 파일이 남아 있어도 앱이 멈추지 않게
  // 일정을 누르면 위클리와 같은 편집창을 엽니다
  $('#kid-today').onclick = e => {
    const row = e.target.closest('.kev');
    if (row) showView('week');
  };
}
