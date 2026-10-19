/* src/의 엔진·제시어·그림판·화면을 합쳐 한 파일로 만든다.
 *   node build.js                                                   → index.html (GitHub Pages용, config.json의 서버 주소)
 *   node build.js --server=http://127.0.0.1:8787 --out=dist/local.html → 로컬 서버로 시험할 때
 */
const fs = require('fs');
const path = require('path');

const SITE = 'https://2juwon.github.io/draw-relay/';
const TITLE = '그림 릴레이';
const DESC = '쓰고, 그리고, 맞히고 — 각자 휴대폰으로 하는 그림 이어 그리기. 마지막에 다 같이 보면 엉뚱해져 있어요';

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
let server = arg('server');
if (server == null) {
  try { server = JSON.parse(read('config.json')).server || ''; } catch (e) { server = ''; }
}
if (server && !/^https?:\/\/[\w.:-]+$/.test(server)) throw new Error('서버 주소가 이상해요: ' + server);

const merged = read('src/ui.html')
  .replace('__SERVER_URL__', () => server)
  .replace('__BUILD_ID__', () => new Date().toISOString().slice(0, 16))
  .replace('/*__GAME__*/', () => read('src/game.js').trim())
  .replace('/*__WORDS__*/', () => read('src/words.js').trim())
  .replace('/*__DRAW__*/', () => read('src/draw.js').trim());

// 인라인 스크립트 문법 확인
const scripts = [...merged.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
scripts.forEach((s) => { new Function(s); });

// 연필 아이콘
const icon = 'data:image/svg+xml,' + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>" +
  "<rect x='1' y='1' width='30' height='30' rx='7' fill='#c79a5f'/>" +
  "<g transform='rotate(-40 16 16)'><rect x='4' y='12' width='19' height='8' rx='1.5' fill='#ffd23f' stroke='#23201c' stroke-width='2'/>" +
  "<path d='M23 12l6 4-6 4z' fill='#f6c9a0' stroke='#23201c' stroke-width='2' stroke-linejoin='round'/><path d='M27 14.7l2 1.3-2 1.3z' fill='#23201c'/></g></svg>"
).replace(/'/g, '%27');

const cut = merged.indexOf('</style>') + '</style>'.length;
const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${DESC}">
<meta name="theme-color" content="#c79a5f">
<meta property="og:type" content="website">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
<meta property="og:url" content="${SITE}">
<meta property="og:image" content="${SITE}og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${icon}">
${merged.slice(0, cut)}
</head>
<body>
${merged.slice(cut).trim()}
</body>
</html>
`;
const out = arg('out') || 'index.html';
fs.mkdirSync(path.dirname(path.join(__dirname, out)), { recursive: true });
fs.writeFileSync(path.join(__dirname, out), html);
console.log(out, (html.length / 1024).toFixed(1) + 'KB,', scripts.length, 'scripts OK,', server ? '서버 ' + server : '서버 없음');
