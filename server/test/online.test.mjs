/* 로컬 서버(wrangler dev --var FAST_TEST:1)에 봇 여러 명을 붙여 온라인 흐름을 끝까지 확인
 *   cd server && npx wrangler dev --var FAST_TEST:1  (다른 창)
 *   node test/online.test.mjs
 * - 게임 중에는 남의 칸이 절대 오지 않는지, 받은 '앞 칸'이 진짜 그 이야기의 앞 칸인지
 * - 시간 초과 채우기, 나가기, 끊겼다 돌아오기, 고치기, 구경꾼, 반응, 한 판 더
 */
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
const DR = require('../../src/game.js');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newPid = () => crypto.randomUUID().replace(/-/g, '');
const randomDrawing = (tag) => ({ ops: [{ c: 1 + (tag % 16), w: tag % 5, p: [10, 20, 300 + tag, 400, 500, 600, 520, 740] }, { f: 1, c: 3, x: 900, y: 700 }] });

class Bot {
  constructor(name, code, opts = {}) {
    Object.assign(this, { name, code, pid: opts.pid || newPid(), auto: opts.auto !== false, lazy: !!opts.lazy });
    this.msgs = [];
    this.errors = [];
    this.state = null;
    this.task = null;
    this.entries = {};
    this.tasks = [];      // 받은 할 일 기록 (나중에 앞 칸이 맞는지 확인)
    this.reacts = [];
    this.forced = 0;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WSB}/ws/${this.code}?pid=${this.pid}&name=${encodeURIComponent(this.name)}`);
      this.ws = ws;
      this.closed = false;
      const timer = setTimeout(() => reject(new Error('연결 시간 초과 ' + this.name)), 5000);
      ws.onerror = () => reject(new Error('ws error ' + this.name));
      ws.onclose = () => { this.closed = true; };
      ws.onmessage = (e) => {
        if (e.data === 'pong') return;
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        if (m.t === 'error') { this.errors.push(m); if (m.fatal) { clearTimeout(timer); resolve(); } return; }
        if (m.t === 'state') { this.state = m; clearTimeout(timer); resolve(); }
        if (m.t === 'task') this.onTask(m.task);
        if (m.t === 'entry') {
          // 발표 전에는 절대 오면 안 됨
          assert.ok(this.state && ['reveal', 'ended'].includes(this.state.room.status),
            `${this.name}: 게임 중에 남의 칸을 받음 ${JSON.stringify(m).slice(0, 80)}`);
          this.entries[`${m.c}:${m.s}`] = m.e;
        }
        if (m.t === 'react') this.reacts.push(m);
        if (m.t === 'force') { this.forced++; if (this.auto && !this.lazy && this.task && !this.task.done) this.answer(this.task); }
      };
    });
  }
  onTask(task) {
    this.task = task;
    if (!task) return;
    if (!this.tasks.some((x) => x.step === task.step)) this.tasks.push(task);
    if (this.auto && !this.lazy && !task.done) setTimeout(() => this.answer(task), 10 + Math.random() * 60);
  }
  answer(task) {
    if (!task || task.done) return;
    const tag = task.step * 100 + task.chain;
    if (task.kind === 'draw') this.send({ t: 'submit', step: task.step, draw: randomDrawing(tag) });
    else this.send({ t: 'submit', step: task.step, text: `${this.name}의 ${task.kind} ${tag}` });
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch (e) { /* 무시 */ } }
  get status() { return this.state && this.state.room.status; }
}

async function until(fn, ms = 15000, what = '조건') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(25); }
  throw new Error(what + ' 기다리다 시간 초과');
}
async function newRoom() {
  const r = await fetch(BASE + '/api/rooms', { method: 'POST' });
  const j = await r.json();
  assert.ok(/^\d{6}$/.test(j.code));
  return j.code;
}
async function revealAllAndCheck(host, bots) {
  const g = host.state.game;
  while (host.status === 'reveal') {
    const before = JSON.stringify(host.state.game.reveal);
    host.send({ t: 'next' });
    await until(() => host.status !== 'reveal' || JSON.stringify(host.state.game.reveal) !== before, 5000, '발표 넘기기');
  }
  assert.strictEqual(host.status, 'ended');
  for (const b of bots) await until(() => Object.keys(b.entries).length === g.n * g.steps, 5000, b.name + ' 앨범 받기');
}
// 받은 '앞 칸'이 마지막에 공개된 그 이야기의 앞 칸과 같은지
function checkTasks(bot, order) {
  for (const task of bot.tasks) {
    if (task.step === 0) { assert.strictEqual(task.prev, null); continue; }
    const real = bot.entries[`${task.chain}:${task.step - 1}`];
    assert.deepStrictEqual(task.prev, real, `${bot.name} 단계 ${task.step} 앞 칸이 다름`);
    assert.strictEqual(order[task.chain][task.step], bot.state.me.seat, '맡은 사람이 다름');
  }
}

async function full5() {
  const code = await newRoom();
  const bots = ['가람', '나래', '다솜', '라온', '마루'].map((n) => new Bot(n, code));
  for (const b of bots) await b.connect();
  const host = bots[0];
  await until(() => host.state.room.members.length === 5, 5000, '5명 입장');
  assert.ok(host.state.me.host);
  assert.ok(!bots[1].state.me.host);
  bots[1].send({ t: 'start' });
  await sleep(150);
  assert.strictEqual(host.status, 'waiting', '방장 아니면 시작 못 함');
  host.send({ t: 'settings', settings: { drawSec: 60, textSec: 30, short: false } });
  await until(() => host.state.room.settings.drawSec === 60);
  host.send({ t: 'start' });
  await until(() => host.status === 'playing', 5000, '시작');
  // 늦게 온 사람은 구경꾼
  const late = new Bot('바다', code);
  await late.connect();
  await until(() => late.state.me && late.state.me.seat === -1, 3000, '구경꾼');
  await until(() => host.status === 'reveal', 20000, '모든 단계 끝');
  assert.strictEqual(late.tasks.length, 0, '구경꾼은 할 일 없음');
  for (const b of bots) assert.strictEqual(b.tasks.length, 5, b.name + ' 할 일 5개');
  const all = bots.concat([late]);
  // 반응
  bots[2].send({ t: 'react', c: 0, s: 0, e: 1 });
  bots[3].send({ t: 'react', c: 0, s: 3, e: 1 }); // 아직 공개 안 된 칸: 무시
  await until(() => late.reacts.length >= 1, 3000, '반응');
  await sleep(200);
  assert.strictEqual(late.reacts.length, 1);
  assert.deepStrictEqual(late.reacts[0].n, [0, 1, 0, 0]);
  await revealAllAndCheck(host, all);
  const order = host.state.game.order;
  for (const b of bots) checkTasks(b, order);
  for (let c = 0; c < 5; c++) for (let s = 0; s < 5; s++) {
    const e = host.entries[`${c}:${s}`];
    assert.strictEqual(e.by, order[c][s]);
    assert.strictEqual(e.kind, DR.kindOf(s));
    assert.ok(!e.auto);
  }
  assert.deepStrictEqual(host.state.reacts['0:0'], [0, 1, 0, 0]);
  // 한 판 더 → 구경꾼도 참가자로
  host.send({ t: 'again' });
  await until(() => late.status === 'waiting', 3000, '대기실로');
  assert.strictEqual(late.state.room.members.length, 6);
  assert.ok(late.state.room.members.every((m) => m.seat === -1));
  all.forEach((b) => b.close());
  console.log('✓ 5명 한 판 + 구경꾼 + 반응 + 한 판 더');
}

async function timeoutsAndDrops() {
  const code = await newRoom();
  const a = new Bot('하나', code), b = new Bot('두리', code), c = new Bot('세나', code, { lazy: true }), d = new Bot('네오', code);
  for (const x of [a, b, c, d]) await x.connect();
  a.send({ t: 'settings', settings: { drawSec: 60, textSec: 30 } }); // 빠른 시험: 6초·3초
  a.send({ t: 'start' });
  await until(() => a.status === 'playing');
  // 세나는 아무것도 안 냄 → 3초 + 0.3초 뒤 채워짐
  const t0 = Date.now();
  await until(() => a.state.game.step === 1, 8000, '시간 초과로 넘어감');
  assert.ok(Date.now() - t0 > 2500, '제한 시간 전에 넘어가면 안 됨');
  assert.ok(c.forced >= 1, '시간이 다 되면 force 신호');
  // 두리가 끊겼다가 돌아옴 → 같은 자리, 할 일 다시 받음
  const bSeat = b.state.me.seat;
  b.auto = false;
  b.close();
  await sleep(100);
  const b2 = new Bot('두리', code, { pid: b.pid });
  await b2.connect();
  await until(() => b2.task, 3000, '돌아와서 할 일');
  assert.strictEqual(b2.state.me.seat, bSeat);
  assert.strictEqual(b2.task.step, a.state.game.step);
  // 그리기 단계: 세나는 임시 저장만 함 → 시간 초과 때 그게 쓰임
  await until(() => c.task && c.task.step === 1, 5000);
  c.send({ t: 'submit', step: 1, draw: randomDrawing(77), done: false });
  // 고치기: 하나가 냈다가 다시 고치고 다시 냄
  await until(() => a.task && a.task.step === 1 && a.task.done, 5000, '하나 냄');
  a.auto = false;
  a.send({ t: 'unsubmit' });
  await until(() => a.task && !a.task.done, 3000, '고치기');
  assert.ok(!a.state.game.done[a.state.me.seat]);
  d.auto = false; // 네오는 다음 단계에서 아무것도 안 하고 나감 (4명은 3칸이라 마지막 칸)
  a.send({ t: 'submit', step: 1, draw: randomDrawing(5) });
  await until(() => a.state.game.step === 2, 9000, '그리기 시간 초과');
  a.auto = true;
  // 네오가 나감 → 이후 단계는 네오를 안 기다림
  d.send({ t: 'leave' });
  await until(() => d.closed, 3000);
  c.lazy = false; c.auto = true;
  for (const x of [a, c]) if (x.task && !x.task.done) x.answer(x.task);
  const t1 = Date.now();
  await until(() => a.status === 'reveal', 12000, '끝까지');
  assert.ok(Date.now() - t1 < 3000, '나간 사람을 기다리면 안 됨');
  assert.ok(a.state.room.members.find((m) => m.name === '네오').left);
  await revealAllAndCheck(a, [a, b2, c]);
  const g = a.state.game, order = g.order;
  const seatC = c.state.me.seat, seatD = 3;
  // 세나의 제시어는 자동, 그림은 임시 저장한 것
  assert.ok(a.entries[`${seatC}:0`].auto && a.entries[`${seatC}:0`].text.length > 0);
  const cDraw = Object.entries(a.entries).find(([k, e]) => +k.split(':')[1] === 1 && e.by === seatC)[1];
  assert.ok(!cDraw.auto && cDraw.draw.ops.length === 2);
  // 네오가 나간 뒤 단계(2)는 자동
  for (const [k, e] of Object.entries(a.entries)) if (e.by === seatD && +k.split(':')[1] >= 2) assert.ok(e.auto, '나간 사람 칸 자동');
  assert.ok(order);
  [a, b2, c].forEach((x) => x.close());
  console.log('✓ 시간 초과·임시 저장·고치기·재접속·나가기');
}

async function everyoneDrops() {
  const code = await newRoom();
  const bots = ['일', '이', '삼'].map((n) => new Bot(n, code));
  for (const x of bots) await x.connect();
  bots[0].send({ t: 'start' });
  await until(() => bots[0].status === 'playing');
  await until(() => bots[0].state.game.step === 1, 5000);
  // 셋째가 끊김 → 나머지가 다 내면 15초(×0.1)만 더 기다리고 넘어감
  bots[2].auto = false;
  bots[2].close();
  const t0 = Date.now();
  await until(() => bots[0].state.game.step === 2, 9000, '끊긴 사람 기다림');
  const waited = Date.now() - t0;
  assert.ok(waited < 4000, '끊긴 사람만 남으면 짧게 기다림 ' + waited);
  // 방장이 끊기면 다음 사람이 방장
  bots[0].auto = false;
  bots[0].close();
  await until(() => bots[1].state.me.host, 3000, '방장 넘김');
  bots[1].close();
  console.log('✓ 끊긴 사람만 남으면 짧게 기다림 · 방장 넘김');
}

async function edgeCases() {
  const code = await newRoom();
  const a = new Bot('하나', code), b = new Bot('하나', code);
  await a.connect(); await b.connect();
  await until(() => a.state.room.members.length === 2);
  assert.deepStrictEqual(a.state.room.members.map((m) => m.name).sort(), ['하나', '하나2'], '같은 이름은 번호');
  a.send({ t: 'start' });
  await until(() => a.errors.length, 2000, '3명 미만 시작 거절');
  assert.match(a.errors[0].message, /3명/);
  // 내보내기
  a.send({ t: 'kick', color: b.state.me.color });
  await until(() => b.errors.some((e) => e.code === 'kicked'), 2000, '내보내기');
  await until(() => a.state.room.members.length === 1, 2000, '내보낸 사람 빠짐');
  const b3 = new Bot('하나', code, { pid: b.pid });
  await b3.connect();
  assert.strictEqual(b3.errors[0].code, 'kicked', '내보낸 사람은 다시 못 들어옴');
  // 없는 방
  const ghost = new Bot('유령', '999999');
  ghost.code = String(100000 + Math.floor(Math.random() * 900000));
  await ghost.connect();
  assert.strictEqual(ghost.errors[0].code, 'no_room');
  // 이상한 pid
  const bad = new Bot('악당', code, { pid: 'zz' });
  await bad.connect();
  assert.strictEqual(bad.errors[0].code, 'bad_player');
  // 12명 넘으면 거절
  const many = [];
  for (let i = 0; i < 11; i++) { const x = new Bot('봇' + i, code, { auto: false }); await x.connect(); many.push(x); }
  const over = new Bot('넘침', code);
  await over.connect();
  assert.strictEqual(over.errors[0] && over.errors[0].code, 'full');
  // 12명 시작 → 짧게(5단계, 맞히기로 끝남)
  a.send({ t: 'settings', settings: { short: true } });
  await until(() => a.state.room.settings.short);
  a.send({ t: 'start' });
  await until(() => a.status === 'playing');
  assert.strictEqual(a.state.game.steps, 5);
  assert.strictEqual(a.state.game.n, 12);
  // 큰 그림도 됨 (점 3만 개 가까이)
  const big = { ops: [] };
  for (let k = 0; k < 290; k++) big.ops.push({ c: k % 18, w: k % 5, p: Array.from({ length: 200 }, (_, i) => (i * 7 + k) % 700) });
  for (const x of many.concat([a])) x.auto = true;
  for (const x of many) x.answer(x.task);
  a.answer(a.task);
  await until(() => a.state.game.step === 1, 5000);
  await until(() => a.task && a.task.step === 1, 3000);
  a.auto = false;
  a.send({ t: 'submit', step: 1, draw: big });
  await until(() => a.task.done, 5000, '큰 그림 냄');
  // 너무 큰 그림은 거절
  a.send({ t: 'unsubmit' });
  await until(() => !a.task.done, 3000);
  const huge = { ops: [{ c: 1, w: 1, p: new Array(70000).fill(3) }] };
  a.send({ t: 'submit', step: 1, draw: huge });
  await until(() => a.errors.length >= 2, 3000, '큰 그림 거절');
  many.concat([a]).forEach((x) => x.close());
  console.log('✓ 이름 겹침·인원·내보내기·없는 방·큰 그림');
}

// 게임 방식마다 한 판: 칸 종류, 받은 앞 칸(정교한 시체는 아래쪽 띠만)
async function modes() {
  for (const mode of ['sandwich', 'secret', 'corpse']) {
    const code = await newRoom();
    const bots = ['가', '나', '다', '라'].map((n) => new Bot(mode + n, code));
    for (const b of bots) await b.connect();
    const host = bots[0];
    await until(() => host.state.room.members.length === 4, 5000, '4명 입장');
    host.send({ t: 'settings', settings: { mode } });
    await until(() => host.state.room.settings.mode === mode, 3000, '방식 바꾸기');
    bots[1].send({ t: 'settings', settings: { mode: 'normal' } }); // 방장 아니면 못 바꿈
    await sleep(150);
    assert.strictEqual(host.state.room.settings.mode, mode);
    host.send({ t: 'start' });
    await until(() => host.status === 'playing', 5000, '시작');
    const g0 = host.state.game;
    assert.strictEqual(g0.mode, mode);
    const want = DR.kindsFor(mode, DR.stepsFor(4, false, mode));
    assert.deepStrictEqual(g0.kinds, want);
    await until(() => host.status === 'reveal', 20000, mode + ' 모든 단계 끝');
    for (const b of bots) assert.deepStrictEqual(b.tasks.map((t) => t.kind), want, b.name + ' 칸 종류');
    await revealAllAndCheck(host, bots);
    const order = host.state.game.order;
    for (const b of bots) {
      for (const task of b.tasks) {
        assert.strictEqual(task.mode, mode);
        assert.strictEqual(order[task.chain][task.step], b.state.me.seat);
        if (task.step === 0) { assert.strictEqual(task.prev, null); continue; }
        const real = b.entries[`${task.chain}:${task.step - 1}`];
        if (mode === 'corpse') {
          assert.ok(task.prev.strip, '띠 표시');
          assert.deepStrictEqual(task.prev.draw, DR.stripOf(real.draw), '띠만 받음');
          assert.ok(task.prev.draw.ops.length > 0, '띠에 선이 있음');
          assert.ok(task.prev.draw.ops.every((o) => !o.f), '채우기는 안 옴');
          assert.ok(JSON.stringify(task.prev.draw).length < JSON.stringify(real.draw).length, '전체보다 작음');
        } else assert.deepStrictEqual(task.prev, real);
      }
    }
    bots.forEach((b) => b.close());
  }
  console.log('✓ 샌드위치·비밀·정교한 시체 한 판씩');
}

(async () => {
  const t0 = Date.now();
  await modes();
  await full5();
  await timeoutsAndDrops();
  await everyoneDrops();
  await edgeCases();
  console.log(`온라인 시험 통과 (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
