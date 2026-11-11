/* ============================================================
   구글 드라이브 — 주간 식단을 담는 데 씁니다.

   원래는 육아일기 코드(diary.js) 안에 있던 부분인데,
   육아일기를 단독 앱(diary-app)으로 떼어내면서
   남아서 쓰이는 이 부분만 따로 옮겼습니다.

   권한은 drive.file 하나만 씁니다 — 이 앱이 만든 파일 말고
   드라이브의 다른 내용에는 접근하지 않습니다.
   ============================================================ */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UP  = 'https://www.googleapis.com/upload/drive/v3';

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

/** 드라이브에 파일을 올리거나 덮어씁니다.
    id 를 주면 덮어쓰기, parent 를 주면 그 폴더에 넣습니다. */
async function driveUpload({ id, name, mime, body, appProperties, parent }) {
  const meta = {};
  if (name) meta.name = name;
  if (appProperties) meta.appProperties = appProperties;
  if (!id && parent) meta.parents = [parent];

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
