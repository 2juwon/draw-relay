/* 그림 릴레이 온라인 서버 (Cloudflare Workers + Durable Objects)
 * - Room: 방 하나. 규칙 엔진(DR)으로 판을 진행하고, 사람마다 자기가 맡은 칸의 '바로 앞 칸'만 보낸다.
 *         다른 사람 그림·글은 발표 때 차례로 공개한다.
 * - Inbox: 의견·고장 신고함
 */
import { DurableObject } from 'cloudflare:workers';
import DR from '../../src/game.js';
import WORDS from '../../src/words.js';
import { Inbox, ADMIN_HTML } from './inbox.js';
export { Inbox };

const GRACE_MS = 3000;                  // 제한 시간이 끝나면 '지금 낸다' 신호를 보내고 이만큼 기다렸다가 채움
const WAIT_GONE_MS = 15000;             // 끊긴 사람만 남았을 때 이만큼만 더 기다림
const EMPTY_ROOM_MS = 30 * 60 * 1000;   // 아무도 없으면 30분 뒤 방 정리
const MAX_MEMBERS = 20;                 // 구경하는 사람 포함
const MAX_MSG = 600000;                 // 그림 한 장 최대 크기(글자 수)
const REACTS = ['❤️', '😂', '👏', '😮'];
const REACT_PER_ENTRY = 12;             // 한 사람이 한 칸에 누를 수 있는 반응 수

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
});

function rand32() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }
const randomCode = () => String(100000 + (rand32() % 900000));
const roomStub = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));
const inboxStub = (env) => env.INBOX.get(env.INBOX.idFromName('main'));
function adminOk(request, env) {
  const want = env.ADMIN_KEY || '';
  const got = request.headers.get('x-admin-key') || '';
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f<>&"'​-‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 8).join('') || '손님';
}
const pickWord = () => WORDS.pick(() => rand32() / 4294967296);

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.speed = env && env.SPEED ? +env.SPEED || 1 : env && env.FAST_TEST === '1' ? 0.1 : 1; // 로컬 시험에서만 시간을 줄임
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) || null;
      const g = this.room && this.room.game;
      if (g) { // 칸 내용은 따로 저장해 둠 (방 정보 한 덩어리가 너무 커지지 않게)
        g.entries = Array.from({ length: g.n }, () => []);
        const m = await ctx.storage.list({ prefix: `e:${this.room.gen}:` });
        for (const [k, v] of m) { const [, , c, s] = k.split(':'); g.entries[+c][+s] = v; }
      }
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /* ── 방 만들기 (워커가 RPC로 부름). 이미 있는 번호면 false ── */
  async init(code) {
    if (this.room) return false;
    this.room = {
      v: 1, code, created: Date.now(), hostPid: null, gen: 0,
      settings: { ...DR.DEFAULT_SETTINGS },
      members: [], status: 'waiting', game: null, deadline: 0, pending: null, reacts: {},
    };
    await this.arm({ kind: 'cleanup', at: Date.now() + EMPTY_ROOM_MS });
    await this.save();
    return true;
  }

  async save() {
    const r = this.room;
    if (!r) return;
    if (!r.game) { await this.ctx.storage.put('room', r); return; }
    const { entries, ...rest } = r.game;
    await this.ctx.storage.put('room', { ...r, game: rest });
  }
  async saveEntry(c, s) {
    const e = this.room.game.entries[c][s];
    if (e) await this.ctx.storage.put(`e:${this.room.gen}:${c}:${s}`, e);
  }
  async saveStepEntries() {
    const g = this.room.game;
    const batch = {};
    for (let c = 0; c < g.n; c++) { const e = g.entries[c][g.step]; if (e) batch[`e:${this.room.gen}:${c}:${g.step}`] = e; }
    const keys = Object.keys(batch);
    for (let i = 0; i < keys.length; i += 64) { // 한 번에 128개까지라 나눠서
      const part = {};
      keys.slice(i, i + 64).forEach((k) => { part[k] = batch[k]; });
      await this.ctx.storage.put(part);
    }
  }
  async dropEntries(gen) {
    const m = await this.ctx.storage.list({ prefix: `e:${gen}:` });
    const keys = [...m.keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
  }

  async arm(p) {
    if (!this.room) return;
    this.room.pending = p || null;
    this.room.deadline = p && p.visible ? p.deadline : 0;
    if (p) await this.ctx.storage.setAlarm(p.at);
    else await this.ctx.storage.deleteAlarm();
  }

  /* ── 접속 정보 ── */
  sockets() { return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1); }
  pidOf(ws) { try { return (ws.deserializeAttachment() || {}).pid || null; } catch (e) { return null; } }
  connectedPids(except) {
    const set = new Set();
    for (const ws of this.sockets()) if (ws !== except) { const p = this.pidOf(ws); if (p) set.add(p); }
    return set;
  }
  memberOf(pid) { return pid && this.room ? this.room.members.find((m) => m.pid === pid) || null : null; }
  seatPid(seat) { const m = this.room.members.find((x) => x.seat === seat); return m ? m.pid : null; }
  nextHost(exclude, online) {
    online = online || this.connectedPids();
    const pref = (m) => m.pid !== exclude && online.has(m.pid) && !m.left;
    const m = this.room.members.find((x) => pref(x) && x.seat >= 0) || this.room.members.find(pref);
    return m ? m.pid : null;
  }
  uniqueName(name, pid) {
    const taken = new Set(this.room.members.filter((m) => m.pid !== pid && !m.left).map((m) => m.name));
    if (!taken.has(name)) return name;
    for (let k = 2; k < 50; k++) { const n = Array.from(name).slice(0, 7).join('') + k; if (!taken.has(n)) return n; }
    return name;
  }
  freeColor() {
    const used = new Set(this.room.members.filter((m) => !m.left).map((m) => m.color));
    for (let i = 0; i < 12; i++) if (!used.has(i)) return i;
    return rand32() % 12;
  }

  /* ── 웹소켓 연결 ── */
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    const pid = (url.searchParams.get('pid') || '').toLowerCase();
    const name = cleanName(url.searchParams.get('name'));
    server.serializeAttachment({ pid });
    const fail = (code, message) => {
      try { server.send(JSON.stringify({ t: 'error', fatal: true, code, message })); server.close(4000, code); } catch (e) { /* 이미 닫힘 */ }
      return new Response(null, { status: 101, webSocket: client });
    };
    if (!/^[a-f0-9]{16,64}$/.test(pid)) return fail('bad_player', '접속 정보가 올바르지 않아요. 새로고침해 주세요');
    if (!this.room) return fail('no_room', '없는 방이에요. 방 번호를 확인해 주세요');
    const res = this.join(pid, name);
    if (!res.ok) return fail(res.code, res.message);
    await this.afterChange();
    this.sendPrivate(server, pid);
    return new Response(null, { status: 101, webSocket: client });
  }

  join(pid, name) {
    const r = this.room;
    const m = this.memberOf(pid);
    if (m) { // 다시 들어옴
      m.left = false; m.away = false;
      if (r.status === 'waiting') m.name = this.uniqueName(name, pid);
      if (!r.hostPid || !this.memberOf(r.hostPid) || this.memberOf(r.hostPid).left) r.hostPid = pid;
      return { ok: true };
    }
    if (r.kicked && r.kicked.includes(pid)) return { ok: false, code: 'kicked', message: '방장이 내보낸 방이라 다시 들어갈 수 없어요' };
    const live = r.members.filter((x) => !x.left);
    if (live.length >= MAX_MEMBERS) return { ok: false, code: 'full', message: '방이 꽉 찼어요' };
    if (r.status === 'waiting' && live.filter((x) => x.seat !== -2).length >= DR.MAX_PLAYERS) {
      return { ok: false, code: 'full', message: `한 방에는 ${DR.MAX_PLAYERS}명까지 들어올 수 있어요` };
    }
    // 대기 중이면 참가자, 게임 중이면 구경꾼(seat -1) — 다음 판부터 같이 함
    r.members.push({ pid, name: this.uniqueName(name, pid), color: this.freeColor(), seat: -1, left: false, away: false, joined: Date.now() });
    if (!r.hostPid || !this.memberOf(r.hostPid) || this.memberOf(r.hostPid).left) r.hostPid = pid;
    return { ok: true };
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MSG) return;
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    const r = this.room;
    if (!r || !msg || typeof msg.t !== 'string') return;
    const pid = this.pidOf(ws);
    const me = this.memberOf(pid);
    if (!me || me.left) return;
    const err = (message) => { try { ws.send(JSON.stringify({ t: 'error', message })); } catch (e) { /* 무시 */ } };
    if (me.away) me.away = false;
    const g = r.game;
    try {
      switch (msg.t) {
        case 'hello':
          this.sendPrivate(ws, pid);
          return this.afterChange();
        case 'settings': {
          if (r.hostPid !== pid || r.status !== 'waiting') return;
          r.settings = DR.cleanSettings(r.settings, msg.settings);
          return this.afterChange();
        }
        case 'start':
          if (r.hostPid !== pid) return err('방장만 시작할 수 있어요');
          if (r.status !== 'waiting') return;
          return this.start(err);
        case 'submit': {
          if (r.status !== 'playing' || !g || me.seat < 0) return err('지금은 낼 수 없어요');
          const done = msg.done !== false;
          if (!done && DR.isDone(g, me.seat)) return; // 이미 낸 뒤 늦게 온 임시 저장은 무시
          const res = DR.submit(g, me.seat, msg, done);
          if (res.error) { if (done) err(res.error); return; }
          await this.saveEntry(res.chain, g.step);
          if (done) this.sendTask(pid);
          if (!done) return; // 임시 저장은 알릴 것 없음
          return this.progress();
        }
        case 'unsubmit':
          if (r.status !== 'playing' || !g || me.seat < 0) return;
          if (DR.unsubmit(g, me.seat)) { await this.saveEntry(DR.chainOf(g, me.seat, g.step), g.step); this.sendTask(pid); }
          return this.afterChange();
        case 'next':
        case 'all': {
          if (r.hostPid !== pid || r.status !== 'reveal' || !g) return;
          const before = { ...g.reveal };
          const res = msg.t === 'all' ? DR.revealAll(g) : DR.revealNext(g);
          if (!res) return;
          if (res.type === 'end') { r.status = 'ended'; await this.afterChange(); return this.sendAll(); }
          if (res.type === 'chain') this.sendEntries(res.chain, 0, res.idx);
          else this.sendEntries(res.chain, before.chain === res.chain ? before.idx + 1 : 0, res.idx);
          return this.afterChange();
        }
        case 'react': {
          if ((r.status !== 'reveal' && r.status !== 'ended') || !g) return;
          const c = msg.c | 0, s = msg.s | 0, e = msg.e | 0;
          if (c < 0 || c >= g.n || s < 0 || s >= g.steps || e < 0 || e >= REACTS.length || !DR.isRevealed(g, c, s)) return;
          const key = `${c}:${s}`;
          const cell = r.reacts[key] || (r.reacts[key] = { n: [0, 0, 0, 0], by: {} });
          if ((cell.by[pid] || 0) >= REACT_PER_ENTRY) return;
          cell.by[pid] = (cell.by[pid] || 0) + 1;
          cell.n[e] += 1;
          this.broadcastRaw({ t: 'react', c, s, e, n: cell.n, color: me.color });
          await this.save();
          return;
        }
        case 'again':
          if (r.hostPid !== pid || r.status !== 'ended') return;
          return this.backToWaiting();
        case 'kick': { // 방장이 대기실에서 내보내기
          if (r.hostPid !== pid || r.status !== 'waiting') return;
          const target = r.members.find((x) => x.color === (msg.color | 0) && x.pid !== pid && !x.left);
          if (!target) return;
          r.members = r.members.filter((x) => x !== target);
          r.kicked = (r.kicked || []).concat(target.pid).slice(-50);
          for (const w of this.ctx.getWebSockets()) if (this.pidOf(w) === target.pid) {
            try { w.send(JSON.stringify({ t: 'error', fatal: true, code: 'kicked', message: '방장이 방에서 내보냈어요' })); w.close(4001, 'kicked'); } catch (e) { /* 무시 */ }
          }
          return this.afterChange();
        }
        case 'leave':
          return this.leave(pid);
      }
    } catch (e) {
      console.error('message', e);
      err('서버에서 처리하지 못했어요');
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (e) { /* 이미 닫힘 */ }
    await this.dropped(ws);
  }
  async webSocketError(ws) { await this.dropped(ws); }

  async dropped(ws) {
    const r = this.room;
    if (!r) return;
    const pid = this.pidOf(ws);
    const m = this.memberOf(pid);
    if (!m) return;
    const online = this.connectedPids(ws);
    if (!online.has(pid)) {
      // 대기실이나 구경꾼이면 자리에서 뺌. 게임 중인 사람은 자리를 남겨 두고 돌아오기를 기다림
      if (r.status === 'waiting' || m.seat < 0) r.members = r.members.filter((x) => x !== m);
      if (r.hostPid === pid) { const h = this.nextHost(pid, online); if (h) r.hostPid = h; }
    }
    await this.afterChange({ except: ws });
  }

  async leave(pid) {
    const r = this.room;
    const m = this.memberOf(pid);
    if (m) {
      if (r.status === 'waiting' || m.seat < 0) r.members = r.members.filter((x) => x !== m);
      else m.left = true; // 게임 중이면 이 사람 칸은 바로 채워 줌
      if (r.hostPid === pid) r.hostPid = this.nextHost(pid);
    }
    for (const w of this.ctx.getWebSockets()) if (this.pidOf(w) === pid) { try { w.close(1000, 'left'); } catch (e) { /* 무시 */ } }
    if (r.status === 'playing') return this.progress();
    await this.afterChange();
  }

  async start(err) {
    const r = this.room;
    const online = this.connectedPids();
    const people = r.members.filter((m) => !m.left && online.has(m.pid)).slice(0, DR.MAX_PLAYERS);
    if (people.length < DR.MIN_PLAYERS) return err(`${DR.MIN_PLAYERS}명부터 시작할 수 있어요`);
    r.members = r.members.filter((m) => !m.left && online.has(m.pid));
    r.members.forEach((m) => { m.seat = -1; m.away = false; });
    people.forEach((m, i) => { m.seat = i; });
    r.gen += 1;
    r.reacts = {};
    r.game = DR.createGame({ players: people.map((m) => ({ name: m.name, color: m.color })), settings: r.settings, seed: rand32() });
    r.game.players.forEach((p, i) => { p.color = people[i].color; });
    r.status = 'playing';
    await this.beginStep();
  }

  // 새 단계 시작: 나간 사람·계속 자리 비운 사람 칸은 바로 채우고 제한 시간을 잼
  async beginStep() {
    const r = this.room, g = r.game;
    const now = Date.now();
    const sec = DR.kindAt(g, g.step) === 'draw' ? g.settings.drawSec : g.settings.textSec;
    const deadline = now + sec * 1000 * this.speed;
    r.stepStarted = now;
    await this.arm({ kind: 'force', step: g.step, gen: r.gen, at: deadline, deadline, visible: true });
    const gone = r.members.filter((m) => m.seat >= 0 && (m.left || m.away)).map((m) => m.seat);
    if (gone.length) {
      DR.fillMissing(g, pickWord, gone);
      await this.saveStepEntries();
    }
    for (const ws of this.sockets()) this.sendPrivate(ws, this.pidOf(ws));
    return this.progress();
  }

  // 낸 사람이 바뀔 때마다: 모두 냈으면 다음 단계, 끊긴 사람만 남았으면 조금만 더 기다림
  async progress() {
    const r = this.room, g = r.game;
    if (!g || r.status !== 'playing') return this.afterChange();
    // 나간 사람 칸은 바로 채움
    const left = r.members.filter((m) => m.seat >= 0 && m.left && !DR.isDone(g, m.seat)).map((m) => m.seat);
    if (left.length) { DR.fillMissing(g, pickWord, left); await this.saveStepEntries(); }
    if (DR.doneCount(g) >= g.n) return this.nextStep();
    const online = this.connectedPids();
    const waitingOn = r.members.filter((m) => m.seat >= 0 && !DR.isDone(g, m.seat));
    const p = r.pending;
    if (waitingOn.length && waitingOn.every((m) => !online.has(m.pid)) && p && p.kind === 'force' && p.step === g.step) {
      const at = Date.now() + WAIT_GONE_MS * this.speed;
      if (at < p.at) await this.arm({ ...p, at });
    }
    return this.afterChange();
  }

  async nextStep() {
    const r = this.room, g = r.game;
    DR.advance(g);
    if (g.phase === 'reveal') {
      r.status = 'reveal';
      await this.arm(null);
      await this.afterChange();
      this.sendEntries(0, 0, g.reveal.idx);
      return;
    }
    return this.beginStep();
  }

  async alarm() {
    const r = this.room;
    if (!r || !r.pending) return;
    const p = r.pending;
    try {
      if (p.kind === 'cleanup') {
        if (this.connectedPids().size) { await this.afterChange(); return; }
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.room = null;
        return;
      }
      const g = r.game;
      if (!g || r.status !== 'playing' || g.step !== p.step || r.gen !== p.gen) { await this.arm(null); await this.afterChange(); return; }
      if (p.kind === 'force') {
        // 아직 안 낸 사람에게 '지금 그린 것까지 낸다'고 알리고 잠깐 기다림
        this.broadcastRaw({ t: 'force', step: g.step });
        await this.arm({ ...p, kind: 'fill', at: Date.now() + GRACE_MS * this.speed, visible: false });
        await this.afterChange();
        return;
      }
      if (p.kind === 'fill') {
        const online = this.connectedPids();
        const missing = r.members.filter((m) => m.seat >= 0 && !DR.isDone(g, m.seat));
        missing.forEach((m) => { if (!online.has(m.pid)) m.away = true; }); // 끊긴 채 시간을 넘기면 다음부터 바로 채움
        DR.fillMissing(g, pickWord);
        await this.saveStepEntries();
        await this.nextStep();
      }
    } catch (e) {
      console.error('alarm', e);
      await this.arm(null);
      await this.afterChange();
    }
  }

  async backToWaiting() {
    const r = this.room;
    const online = this.connectedPids();
    const oldGen = r.gen;
    r.members = r.members.filter((m) => !m.left && online.has(m.pid)).slice(0, DR.MAX_PLAYERS);
    r.members.forEach((m) => { m.seat = -1; m.away = false; });
    r.status = 'waiting';
    r.game = null;
    r.reacts = {};
    await this.arm({ kind: 'cleanup', at: Date.now() + EMPTY_ROOM_MS });
    await this.dropEntries(oldGen);
    await this.afterChange();
  }

  async afterChange(opt = {}) {
    const r = this.room;
    if (!r) return;
    const online = this.connectedPids(opt.except);
    if (!online.size) { if (!r.pending || r.pending.kind !== 'cleanup') await this.arm({ kind: 'cleanup', at: Date.now() + EMPTY_ROOM_MS }); }
    else if (r.pending && r.pending.kind === 'cleanup') await this.arm(null);
    if (r.hostPid && !online.has(r.hostPid)) { const h = this.nextHost(r.hostPid, online); if (h) r.hostPid = h; }
    await this.save();
    this.broadcast(online);
  }

  broadcast(online) {
    const r = this.room;
    if (!r) return;
    const members = r.members.filter((m) => !m.left || m.seat >= 0).map((m) => ({
      name: m.name, color: m.color, seat: m.seat, left: !!m.left, away: !!m.away,
      online: online.has(m.pid), host: m.pid === r.hostPid,
    }));
    const g = r.game;
    const base = {
      t: 'state', now: Date.now(),
      room: { code: r.code, status: r.status, settings: r.settings, gen: r.gen, deadline: r.deadline || 0, members },
      game: g ? DR.summary(g) : null,
      reacts: g && (r.status === 'reveal' || r.status === 'ended') ? Object.fromEntries(Object.entries(r.reacts).map(([k, v]) => [k, v.n])) : null,
    };
    const text = JSON.stringify(base);
    for (const ws of this.sockets()) {
      const pid = this.pidOf(ws);
      const m = this.memberOf(pid);
      // 나에 대한 것만 덧붙임 (내 색·자리·방장 여부)
      const me = m ? { color: m.color, seat: m.seat, host: pid === r.hostPid } : null;
      try { ws.send(text.slice(0, -1) + ',"me":' + JSON.stringify(me) + '}'); } catch (e) { /* 끊긴 소켓 */ }
    }
  }
  broadcastRaw(obj) {
    const text = JSON.stringify(obj);
    for (const ws of this.sockets()) { try { ws.send(text); } catch (e) { /* 무시 */ } }
  }

  // 접속하거나 단계가 바뀔 때: 할 일, 또는 발표 중이면 지금까지 공개된 칸
  sendPrivate(ws, pid) {
    const r = this.room, g = r && r.game;
    if (!g || !ws) return;
    const m = this.memberOf(pid);
    if (r.status === 'playing') {
      if (m && m.seat >= 0) this.sendTo(ws, { t: 'task', gen: r.gen, task: DR.taskFor(g, m.seat) });
      return;
    }
    if (r.status === 'reveal') {
      for (let c = 0; c <= g.reveal.chain; c++) {
        const upto = c < g.reveal.chain ? g.steps - 1 : g.reveal.idx;
        for (let s = 0; s <= upto; s++) this.sendTo(ws, this.entryMsg(c, s));
      }
      return;
    }
    if (r.status === 'ended') for (let c = 0; c < g.n; c++) for (let s = 0; s < g.steps; s++) this.sendTo(ws, this.entryMsg(c, s));
  }
  sendTask(pid) {
    const r = this.room, m = this.memberOf(pid);
    if (!m || m.seat < 0 || !r.game) return;
    for (const ws of this.sockets()) if (this.pidOf(ws) === pid) this.sendTo(ws, { t: 'task', gen: r.gen, task: DR.taskFor(r.game, m.seat) });
  }
  entryMsg(c, s) {
    const e = this.room.game.entries[c][s];
    return { t: 'entry', gen: this.room.gen, c, s, e: e ? DR.publicEntry(e) : null };
  }
  sendEntries(c, from, to) { for (let s = from; s <= to; s++) this.broadcastRaw(this.entryMsg(c, s)); }
  sendAll() {
    const g = this.room.game;
    // 발표에서 이미 받은 칸도 있지만, 늦게 온 사람·새로고침한 사람을 위해 전부 다시
    for (let c = 0; c < g.n; c++) for (let s = 0; s < g.steps; s++) this.broadcastRaw(this.entryMsg(c, s));
  }
  sendTo(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* 무시 */ } }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        for (let k = 0; k < 6; k++) {
          const code = randomCode();
          if (await roomStub(env, code).init(code)) return json({ code });
        }
        return json({ error: '방을 만들지 못했어요' }, 500);
      }
      if (url.pathname === '/api/feedback' && request.method === 'POST') {
        if (+(request.headers.get('content-length') || 0) > 40000) return json({ error: '내용이 너무 길어요' }, 413);
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '보낸 내용을 읽지 못했어요' }, 400); }
        const who = request.headers.get('CF-Connecting-IP') || 'anon';
        const r = await inboxStub(env).add({ ...body, ua: request.headers.get('User-Agent') || '' }, who);
        return json(r, r.error ? 429 : 200);
      }
      if (url.pathname === '/admin') return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' } });
      if (url.pathname.startsWith('/api/admin/')) {
        if (!env.ADMIN_KEY) return json({ error: '관리자 비밀번호(ADMIN_KEY)가 아직 설정되지 않았어요' }, 503);
        if (!adminOk(request, env)) return json({ error: '비밀번호가 맞지 않아요' }, 401);
        if (url.pathname === '/api/admin/feedback' && request.method === 'GET') return json({ items: await inboxStub(env).list() });
        const fm = url.pathname.match(/^\/api\/admin\/feedback\/([\w-]{6,40})$/);
        if (fm && request.method === 'POST') {
          let b = {};
          try { b = await request.json(); } catch (e) { /* 빈 본문 */ }
          return json({ ok: await inboxStub(env).setStatus(fm[1], b.status) });
        }
        if (fm && request.method === 'DELETE') return json({ ok: await inboxStub(env).remove(fm[1]) });
        return json({ error: 'not found' }, 404);
      }
      const m = url.pathname.match(/^\/ws\/(\d{6})$/);
      if (m) {
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426, headers: CORS });
        return roomStub(env, m[1]).fetch(request);
      }
      if (url.pathname === '/') return new Response('그림 릴레이 서버가 돌고 있어요', { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: '서버 오류가 났어요' }, 500);
    }
  },
};
