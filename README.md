# 그림 릴레이

쓰고, 그리고, 맞히고 — 각자 휴대폰으로 하는 그림 이어 그리기 게임.
마지막에 이야기를 하나씩 펼쳐 보면 처음 제시어가 엉뚱하게 변해 있어요.

**하러 가기: https://2juwon.github.io/draw-relay/**

## 하는 법

1. 한 사람이 **방 만들기** → 초대 링크(또는 방 번호 6자리)를 보냄. 3명부터 12명까지
2. **제시어 쓰기** — 모두 하나씩. 막히면 주사위로 아무거나
3. **그리기** — 옆 사람에게서 넘어온 글을 그림으로 (펜·지우개·채우기·굵기 5단계·18색·되돌리기)
4. **맞히기** — 넘어온 그림만 보고 뭔지 적기. 이걸 사람 수만큼 이어 감
5. **다 같이 보기** — 방장이 한 칸씩 넘기며 이야기를 펼침. 그림은 그린 순서대로 다시 그려지고, 칸마다 ❤️😂👏😮 반응
6. **앨범** — 모든 이야기 다시 보기, 이야기 하나를 세로로 긴 이미지로 저장, 반응을 가장 많이 받은 '오늘의 한 칸'

설정(방장): 그리는 시간 60초·90초·2분·3분 / 쓰고 맞히는 시간 30·40·60초 / 이야기 길이 모두 한 번씩·짧게(6칸)

## 정해 둔 것

- 이야기는 사람 수만큼 생기고, 한 이야기는 같은 사람에게 두 번 가지 않음. 앉은 순서는 판마다 섞음
- 시간이 다 되면 그리던 것까지 그대로 냄. 아무것도 안 했으면 제시어는 주사위, 그림은 빈 그림, 맞히기는 빈칸
- 모두 내면 시간이 남아도 바로 다음 단계. 낸 뒤에도 다음 단계 전까지 '고치기' 가능
- 끊긴 사람: 자리를 남겨 두고 기다림(돌아오면 그리던 그림 그대로). 끊긴 사람만 남으면 15초만 더 기다리고, 끊긴 채 한 단계를 넘기면 그다음부터는 바로 채움
- '나가기'를 누른 사람 칸은 바로 채움. 게임 중에 들어온 사람은 구경하다가 다음 판부터 참가
- 방장이 끊기면 다음 사람이 방장. 방장은 대기실에서 사람을 내보낼 수 있고, 내보낸 사람은 그 방에 다시 못 들어옴
- 게임 중에는 서버가 각자에게 '내가 맡은 칸의 바로 앞 칸'만 보냄. 다른 칸은 발표 때 차례로 공개
- 그림은 이미지가 아니라 선 기록(좌표 1000×750)으로 주고받아서 가볍고, 발표 때 그린 순서대로 다시 그릴 수 있음
- 아무도 없는 방은 30분 뒤 정리. 그림은 서버에 따로 남기지 않음

## 구조

```
index.html            GitHub Pages 완성본 (node build.js 로 만듦)
src/game.js           규칙 엔진 DR — 순수 JSON 상태, 단계 배정·제출·채우기·발표
src/words.js          주사위 제시어 105개
src/draw.js           그림판 DRAW — 그리기·채우기·되돌리기·다시 그리기 재생
src/ui.html           화면
server/               Cloudflare Workers + Durable Objects (Room: 방 하나, Inbox: 의견함)
config.json           서버 주소 → build.js 가 index.html 에 넣음
test/game.test.js     규칙 시험
server/test/online.test.mjs   로컬 서버에 봇 여러 명 붙여 끝까지
test/browser.py       브라우저 4개(휴대폰 3 + PC 1)로 한 판 끝까지
```

## 고치고 올리기

```bash
node test/game.test.js          # 규칙 시험
node build.js                   # index.html 다시 만들기
```

`main`에 `server/`나 `src/game.js`·`src/words.js`가 바뀌어 올라가면 GitHub Actions '서버 배포'가 시험 후 Cloudflare에 올립니다.
저장소 Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, (의견함 관리) `ADMIN_KEY`.
의견함: https://draw-relay.2juwon.workers.dev/admin

### 로컬에서 시험하기

```bash
cd server && npm ci
npx wrangler dev --var FAST_TEST:1            # 시간 10배 빠르게
node test/online.test.mjs                     # 다른 창에서

npx wrangler dev --var SPEED:0.5 --port 8788  # 브라우저 시험용 (시간 절반)
cd .. && node build.js --server=http://127.0.0.1:8788 --out=dist/local.html
python3 -m http.server 8000 --directory dist
python3 test/browser.py
```
