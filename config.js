/* ============================================================
   설정 파일 — 이 파일 한 줄만 바꾸면 됩니다.

   1) Google Cloud Console 에서 OAuth 클라이언트 ID 를 발급받고
   2) 아래 GOOGLE_CLIENT_ID 값에 붙여넣으세요.

   자세한 절차는 같은 폴더의 "설정가이드.md" 를 보세요.
   ============================================================ */

window.APP_CONFIG = {

  /* ① 필수 — 발급받은 OAuth 클라이언트 ID */
  GOOGLE_CLIENT_ID: '여기에_클라이언트_ID를_붙여넣으세요.apps.googleusercontent.com',

  /* ② 일정을 저장할 캘린더. 'primary' = 내 기본 캘린더 */
  CALENDAR_ID: 'primary',

  /* ③ 구글 Tasks 에 만들어질 목록 이름 (없으면 자동 생성) */
  TASKLIST_TODO:     '할 일',
  TASKLIST_SHOPPING: '쇼핑 리스트',

  /* ④ 쇼핑 리스트 분류 — 자유롭게 늘리거나 이름을 바꿔도 됩니다 */
  SHOP_CATEGORIES: ['식료품', '생필품', '기타'],

  /* ⑤ 주 시작 요일 : 1 = 월요일, 0 = 일요일 */
  WEEK_START: 1
};
