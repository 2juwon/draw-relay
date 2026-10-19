/* 그림 릴레이 규칙 엔진
 * - 상태는 JSON 그대로 저장·전송할 수 있는 순수 데이터
 * - 한 사람이 이야기 하나를 시작(제시어)하고, 이야기가 사람들 사이를 돌며 그리기 → 맞히기 → 그리기 … 로 이어짐
 * - 단계 s에서 이야기 c를 맡는 사람은 seatOf(g, c, s). 한 이야기는 같은 사람에게 두 번 가지 않음
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DR = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_PLAYERS = 3;
  const MAX_PLAYERS = 12;
  const SHORT_STEPS = 5;           // 짧게 하기: 최대 5칸 (늘 맞히기로 끝나게 홀수)
  const TEXT_MAX = 60;
  const W = 1000, H = 750;          // 그림 좌표 (가로 1000 × 세로 750)
  const COLORS = 18;                // 팔레트 색 수 (0번 = 흰색, 지우개도 흰색)
  const SIZES = 5;                  // 굵기 단계 수
  const MAX_OPS = 4000;
  const MAX_POINTS = 30000;

  const MODES = ['normal', 'sandwich', 'secret', 'corpse'];
  const CORPSE_PARTS = 3;           // 정교한 시체: 머리·몸통·다리
  const STRIP_TOP = 660;            // 정교한 시체: 다음 사람에게 보여 주는 아래쪽 띠 (y 660~750)
  const DEFAULT_SETTINGS = Object.freeze({ drawSec: 90, textSec: 40, short: false, mode: 'normal' });
  const DRAW_SECS = [60, 90, 120, 180];
  const TEXT_SECS = [30, 40, 60];

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function cleanSettings(cur, s) {
    const out = { ...DEFAULT_SETTINGS, ...(cur || {}) };
    if (!s || typeof s !== 'object') return out;
    if (DRAW_SECS.includes(s.drawSec)) out.drawSec = s.drawSec;
    if (TEXT_SECS.includes(s.textSec)) out.textSec = s.textSec;
    if (typeof s.short === 'boolean') out.short = s.short;
    if (MODES.includes(s.mode)) out.mode = s.mode;
    return out;
  }

  // 글자: 제어 문자 빼고, 공백 한 칸으로, 60자까지
  function cleanText(s) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(s).slice(0, TEXT_MAX).join('');
  }

  /* 그림: { ops: [ {c, w, p:[x,y,x,y,…]} 선 | {f:1, c, x, y} 채우기 ] }
   * 좌표는 정수 0..1000 / 0..750, 색은 팔레트 번호, 굵기는 단계 번호. 이상하면 null */
  function cleanDrawing(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.ops)) return null;
    if (d.ops.length > MAX_OPS) return null;
    const ops = [];
    let points = 0;
    const int = (v, max) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : null);
    for (const o of d.ops) {
      if (!o || typeof o !== 'object') return null;
      const c = o.c | 0;
      if (c < 0 || c >= COLORS) return null;
      if (o.f) {
        const x = int(o.x, W), y = int(o.y, H);
        if (x == null || y == null) return null;
        ops.push({ f: 1, c, x, y });
        continue;
      }
      const w = o.w | 0;
      if (w < 0 || w >= SIZES || !Array.isArray(o.p) || o.p.length < 2 || o.p.length % 2) return null;
      const p = new Array(o.p.length);
      for (let i = 0; i < o.p.length; i++) {
        const v = int(o.p[i], i % 2 ? H : W);
        if (v == null) return null;
        p[i] = v;
      }
      points += p.length / 2;
      if (points > MAX_POINTS) return null;
      ops.push({ c, w, p });
    }
    return { ops };
  }

  /* 이야기 길이: 사람 수만큼(짧게면 최대 5칸). 다만 칸 수가 짝수면 마지막이 그림이 되므로 한 칸 줄여
   * 늘 '맞히기'로 끝나게 함 (한 칸을 더 붙이면 처음 쓴 사람이 자기 이야기를 맞히게 되어 답을 알고 맞히는 꼴) */
  function stepsFor(n, short, mode) {
    if (mode === 'corpse') return CORPSE_PARTS;           // 머리 → 몸통 → 다리
    let k = short ? Math.min(n, SHORT_STEPS) : n;
    if (mode !== 'sandwich' && k % 2 === 0) k -= 1;        // 샌드위치는 마지막 칸을 늘 맞히기로 정해 두므로 그대로
    return Math.max(3, k);
  }

  /* 칸마다 할 일
   * 기본·비밀: 제시어 → 그림 → 맞히기 → 그림 → … → 맞히기
   * 샌드위치:  제시어 → 그림 → 따라 그리기 → … → 맞히기 (가운데는 모두 그림)
   * 정교한 시체: 그림(머리) → 그림(몸통) → 그림(다리) — 앞 사람 그림은 아래쪽 띠만 보임 */
  function kindsFor(mode, steps) {
    return Array.from({ length: steps }, (_, s) => {
      if (mode === 'corpse') return 'draw';
      if (mode === 'sandwich') return s === 0 ? 'prompt' : s === steps - 1 ? 'guess' : 'draw';
      return kindOf(s);
    });
  }
  function kindAt(g, step) { return g.kinds ? g.kinds[step] : kindOf(step); }

  // 정교한 시체: 그림에서 아래쪽 띠(y ≥ top)에 걸친 선 조각만 남김 (채우기는 뺌)
  function stripOf(draw, top = STRIP_TOP) {
    const ops = [];
    for (const o of (draw && draw.ops) || []) {
      if (o.f) continue;
      const p = o.p, n = p.length / 2;
      let run = null;
      const flush = () => { if (run && run.length) ops.push({ c: o.c, w: o.w, p: run }); run = null; };
      for (let i = 0; i < n; i++) {
        // 굵은 선은 띠 조금 위에서 시작해도 띠 안으로 번져 보이므로 굵기 반만큼 여유
        const inside = p[i * 2 + 1] >= top - 32;
        if (inside) {
          if (!run) { run = []; if (i > 0) run.push(p[i * 2 - 2], p[i * 2 - 1]); } // 앞 점 하나로 이어지는 방향을 살림
          run.push(p[i * 2], p[i * 2 + 1]);
        } else if (run) { run.push(p[i * 2], p[i * 2 + 1]); flush(); }
      }
      flush();
    }
    return { ops };
  }

  function kindOf(step) { return step === 0 ? 'prompt' : step % 2 ? 'draw' : 'guess'; }

  /* players: [{ name }] (자리 순서), settings, seed */
  function createGame({ players, settings, seed }) {
    const n = players.length;
    if (n < MIN_PLAYERS || n > MAX_PLAYERS) throw new Error('인원이 맞지 않아요');
    const st = cleanSettings(null, settings);
    const rnd = mulberry32(seed >>> 0 || 1);
    // 앉은 순서를 섞어서 '늘 같은 사람에게서 받는' 느낌을 줄임
    const ring = players.map((_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ring[i], ring[j]] = [ring[j], ring[i]]; }
    const pos = new Array(n);
    ring.forEach((seat, k) => { pos[seat] = k; });
    return {
      v: 1, n, seed: seed >>> 0,
      players: players.map((p) => ({ name: String(p.name || '') })),
      settings: st,
      mode: st.mode,
      steps: stepsFor(n, st.short, st.mode),
      ring, pos,
      kinds: kindsFor(st.mode, stepsFor(n, st.short, st.mode)),
      step: 0,
      phase: 'play',             // play → reveal → end
      entries: Array.from({ length: n }, () => []),   // entries[이야기][단계] = { by, kind, text | draw, auto, done }
      reveal: null,              // { chain, idx } 발표 중 보이는 마지막 칸
    };
  }

  // 이야기 c(= c번 자리 사람이 시작)를 단계 s에서 맡는 사람
  function seatOf(g, chain, step) { return g.ring[(g.pos[chain] + step) % g.n]; }
  // 단계 s에서 이 사람이 맡는 이야기
  function chainOf(g, seat, step) { return g.ring[((g.pos[seat] - step) % g.n + g.n) % g.n]; }

  // 지금 이 사람이 할 일 (이전 칸 내용 포함). 할 일이 없으면 null
  function taskFor(g, seat) {
    if (g.phase !== 'play' || seat < 0 || seat >= g.n) return null;
    const chain = chainOf(g, seat, g.step);
    const kind = kindAt(g, g.step);
    const prev = g.step > 0 ? g.entries[chain][g.step - 1] : null;
    const mine = g.entries[chain][g.step] || null;
    let pv = prev ? publicEntry(prev) : null;
    if (pv && g.mode === 'corpse') pv = { by: pv.by, kind: 'draw', auto: pv.auto, strip: true, draw: stripOf(prev.draw) };
    return {
      step: g.step, steps: g.steps, kind, chain, mode: g.mode || 'normal',
      part: g.mode === 'corpse' ? g.step : null,
      prev: pv,
      mine: mine ? publicEntry(mine) : null,
      done: !!(mine && mine.done),
    };
  }

  function publicEntry(e) {
    const o = { by: e.by, kind: e.kind, auto: !!e.auto };
    if (e.kind === 'draw') o.draw = e.draw; else o.text = e.text;
    return o;
  }

  /* 제출. done=false면 임시 저장(시간 초과 때 그대로 씀). 결과 { ok } 또는 { error } */
  function submit(g, seat, payload, done = true) {
    if (g.phase !== 'play') return { error: '지금은 낼 수 없어요' };
    if (seat < 0 || seat >= g.n) return { error: '자리가 없어요' };
    if (!payload || payload.step !== g.step) return { error: '이미 다음 단계로 넘어갔어요' };
    const chain = chainOf(g, seat, g.step);
    const kind = kindAt(g, g.step);
    const e = { by: seat, kind, auto: false, done: !!done };
    if (kind === 'draw') {
      const d = cleanDrawing(payload.draw);
      if (!d) return { error: '그림을 읽지 못했어요' };
      e.draw = d;
    } else {
      e.text = cleanText(payload.text);
      if (done && !e.text) return { error: kind === 'prompt' ? '제시어를 적어 주세요' : '생각나는 걸 적어 주세요' };
    }
    g.entries[chain][g.step] = e;
    return { ok: true, chain };
  }

  // 낸 걸 다시 고치기
  function unsubmit(g, seat) {
    if (g.phase !== 'play') return false;
    const e = g.entries[chainOf(g, seat, g.step)][g.step];
    if (!e || !e.done) return false;
    e.done = false;
    return true;
  }

  function isDone(g, seat) {
    if (g.phase !== 'play') return true;
    const e = g.entries[chainOf(g, seat, g.step)][g.step];
    return !!(e && e.done);
  }
  function doneCount(g) { let k = 0; for (let i = 0; i < g.n; i++) if (isDone(g, i)) k++; return k; }

  /* 안 낸 사람 칸 채우기: 임시 저장이 있으면 그걸로, 없으면 제시어는 아무거나·그림은 빈 그림·맞히기는 빈칸 */
  function fillMissing(g, pickWord, seats) {
    if (g.phase !== 'play') return [];
    const filled = [];
    for (let seat = 0; seat < g.n; seat++) {
      if (seats && !seats.includes(seat)) continue;
      const chain = chainOf(g, seat, g.step);
      const cur = g.entries[chain][g.step];
      if (cur && cur.done) continue;
      const kind = kindAt(g, g.step);
      let e;
      if (cur && (kind === 'draw' ? cur.draw && cur.draw.ops.length : cur.text)) e = { ...cur, done: true };
      else if (kind === 'prompt') e = { by: seat, kind, text: cleanText(pickWord()), auto: true, done: true };
      else if (kind === 'draw') e = { by: seat, kind, draw: { ops: [] }, auto: true, done: true };
      else e = { by: seat, kind, text: '', auto: true, done: true };
      g.entries[chain][g.step] = e;
      filled.push(seat);
    }
    return filled;
  }

  // 모두 냈으면 다음 단계로. 마지막 단계 뒤에는 발표
  function advance(g) {
    if (g.phase !== 'play' || doneCount(g) < g.n) return false;
    g.step += 1;
    if (g.step >= g.steps) {
      g.phase = 'reveal';
      g.reveal = { chain: 0, idx: 0 };
    }
    return true;
  }

  // 발표: 다음 칸 → 이야기 끝이면 다음 이야기 → 모두 끝이면 end
  function revealNext(g) {
    if (g.phase !== 'reveal') return null;
    const r = g.reveal;
    if (r.idx < g.steps - 1) { r.idx += 1; return { type: 'entry', chain: r.chain, idx: r.idx }; }
    if (r.chain < g.n - 1) { r.chain += 1; r.idx = 0; return { type: 'chain', chain: r.chain, idx: 0 }; }
    g.phase = 'end';
    g.reveal = null;
    return { type: 'end' };
  }
  // 이 이야기 남은 칸 한 번에 보여 주기
  function revealAll(g) {
    if (g.phase !== 'reveal') return null;
    g.reveal.idx = g.steps - 1;
    return { type: 'entry', chain: g.reveal.chain, idx: g.reveal.idx };
  }

  // 발표 중 지금까지 보여 준 칸인지
  function isRevealed(g, chain, idx) {
    if (g.phase === 'end') return true;
    if (g.phase !== 'reveal') return false;
    return chain < g.reveal.chain || (chain === g.reveal.chain && idx <= g.reveal.idx);
  }

  // 남들에게 보여도 되는 요약 (내용 없음)
  function summary(g) {
    const done = [];
    for (let i = 0; i < g.n; i++) done.push(isDone(g, i));
    return {
      n: g.n, steps: g.steps, step: g.step, phase: g.phase, kind: g.phase === 'play' ? kindAt(g, g.step) : null, mode: g.mode || 'normal', kinds: g.kinds,
      settings: g.settings, players: g.players, done, reveal: g.reveal,
      // 이야기마다 맡은 사람 순서 (발표·앨범에서 '누가' 표시용 — 내용은 따로)
      order: g.phase === 'play' ? null : Array.from({ length: g.n }, (_, c) => Array.from({ length: g.steps }, (_, s) => seatOf(g, c, s))),
    };
  }

  return {
    MIN_PLAYERS, MAX_PLAYERS, SHORT_STEPS, MODES, CORPSE_PARTS, STRIP_TOP, TEXT_MAX, W, H, COLORS, SIZES, MAX_OPS, MAX_POINTS,
    DEFAULT_SETTINGS, DRAW_SECS, TEXT_SECS,
    mulberry32, stepsFor, kindsFor, kindAt, stripOf, cleanSettings, cleanText, cleanDrawing, kindOf, createGame, seatOf, chainOf, taskFor, publicEntry,
    submit, unsubmit, isDone, doneCount, fillMissing, advance, revealNext, revealAll, isRevealed, summary,
  };
});
