/* 규칙 엔진 시험: node test/game.test.js */
const assert = require('assert');
const DR = require('../src/game.js');
const WORDS = require('../src/words.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('✗', name); throw e; }
}
const players = (n) => Array.from({ length: n }, (_, i) => ({ name: 'P' + i }));
const line = (c = 1) => ({ ops: [{ c, w: 1, p: [10, 10, 200, 300] }] });
function playStep(g) {
  for (let s = 0; s < g.n; s++) {
    const k = DR.kindOf(g.step);
    const r = DR.submit(g, s, k === 'draw' ? { step: g.step, draw: line() } : { step: g.step, text: `${k}-${g.step}-${s}` });
    assert.ok(r.ok, JSON.stringify(r));
  }
  assert.ok(DR.advance(g));
}

t('인원 제한', () => {
  assert.throws(() => DR.createGame({ players: players(2), seed: 1 }));
  assert.throws(() => DR.createGame({ players: players(13), seed: 1 }));
  DR.createGame({ players: players(3), seed: 1 });
  DR.createGame({ players: players(12), seed: 1 });
});

t('한 이야기는 같은 사람에게 두 번 가지 않고, 한 단계에 한 사람은 이야기 하나', () => {
  for (let n = 3; n <= 12; n++) for (let seed = 1; seed < 30; seed++) {
    const g = DR.createGame({ players: players(n), seed });
    for (let c = 0; c < n; c++) {
      const seen = new Set();
      for (let s = 0; s < g.steps; s++) seen.add(DR.seatOf(g, c, s));
      assert.strictEqual(seen.size, g.steps);
      assert.strictEqual(DR.seatOf(g, c, 0), c, '이야기는 시작한 사람 것');
    }
    for (let s = 0; s < g.steps; s++) {
      const got = new Set();
      for (let p = 0; p < n; p++) {
        const c = DR.chainOf(g, p, s);
        assert.strictEqual(DR.seatOf(g, c, s), p);
        got.add(c);
      }
      assert.strictEqual(got.size, n);
    }
  }
});

t('단계 종류: 제시어 → 그리기 → 맞히기 반복', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(DR.kindOf), ['prompt', 'draw', 'guess', 'draw', 'guess', 'draw']);
});

t('이야기 길이: 사람 수, 짧게면 최대 5칸, 늘 맞히기로 끝남', () => {
  assert.strictEqual(DR.createGame({ players: players(9), seed: 3, settings: { short: true } }).steps, 5);
  assert.strictEqual(DR.createGame({ players: players(4), seed: 3, settings: { short: true } }).steps, 3);
  assert.strictEqual(DR.createGame({ players: players(9), seed: 3 }).steps, 9);
  assert.strictEqual(DR.createGame({ players: players(8), seed: 3 }).steps, 7);
  assert.strictEqual(DR.createGame({ players: players(3), seed: 3 }).steps, 3);
  for (let n = 3; n <= 12; n++) for (const short of [false, true]) {
    const k = DR.stepsFor(n, short);
    assert.strictEqual(DR.kindOf(k - 1), 'guess', `${n}명 short=${short}`);
    assert.ok(k <= n);
  }
});

t('할 일에는 바로 앞 칸만 보임', () => {
  const g = DR.createGame({ players: players(5), seed: 7 });
  const t0 = DR.taskFor(g, 2);
  assert.strictEqual(t0.kind, 'prompt');
  assert.strictEqual(t0.prev, null);
  playStep(g);
  for (let p = 0; p < 5; p++) {
    const task = DR.taskFor(g, p);
    assert.strictEqual(task.kind, 'draw');
    assert.strictEqual(task.prev.kind, 'prompt');
    assert.strictEqual(task.prev.by, task.chain);
    assert.strictEqual(task.prev.text, `prompt-0-${task.chain}`);
    assert.notStrictEqual(task.chain, p);
  }
  playStep(g);
  const task = DR.taskFor(g, 0);
  assert.strictEqual(task.kind, 'guess');
  assert.ok(task.prev.draw && task.prev.draw.ops.length === 1);
  assert.strictEqual(task.prev.text, undefined);
});

t('잘못된 제출 거절', () => {
  const g = DR.createGame({ players: players(4), seed: 2 });
  assert.ok(DR.submit(g, 0, { step: 0, text: '   ' }).error);
  assert.ok(DR.submit(g, 0, { step: 1, text: '고양이' }).error, '다른 단계');
  assert.ok(DR.submit(g, 9, { step: 0, text: '고양이' }).error);
  assert.ok(DR.submit(g, 0, { step: 0, text: '고양이' }).ok);
  assert.ok(!DR.advance(g), '아직 다 안 냄');
  for (let p = 1; p < 4; p++) DR.submit(g, p, { step: 0, text: 'x' });
  assert.ok(DR.advance(g));
  assert.ok(DR.submit(g, 0, { step: 1, text: '글자' }).error, '그리기 단계에 글자');
  assert.ok(DR.submit(g, 0, { step: 1, draw: { ops: [{ c: 99, w: 1, p: [1, 1] }] } }).error, '없는 색');
  assert.ok(DR.submit(g, 0, { step: 1, draw: { ops: [{ c: 1, w: 1, p: [1, 1, 3] }] } }).error, '홀수 좌표');
  assert.ok(DR.submit(g, 0, { step: 1, draw: { ops: [{ c: 1, w: 9, p: [1, 1] }] } }).error, '없는 굵기');
  assert.ok(DR.submit(g, 0, { step: 1, draw: { ops: [{ c: 1, w: 1, p: [1, 'x'] }] } }).error, '숫자 아님');
  assert.ok(DR.submit(g, 0, { step: 1, draw: { ops: [{ c: 1, w: 1, p: [-50, 9999] }] } }).ok, '바깥 좌표는 끝으로 맞춤');
  assert.deepStrictEqual(DR.taskFor(g, 0).mine.draw.ops[0].p, [0, 750]);
  const big = { ops: [{ c: 1, w: 1, p: new Array((DR.MAX_POINTS + 1) * 2).fill(5) }] };
  assert.ok(DR.submit(g, 1, { step: 1, draw: big }).error, '점 너무 많음');
});

t('글자 정리: 제어 문자·긴 글', () => {
  assert.strictEqual(DR.cleanText('  가\n\n나\t다‮ '), '가 나 다');
  assert.strictEqual(Array.from(DR.cleanText('가'.repeat(100))).length, DR.TEXT_MAX);
  assert.strictEqual(DR.cleanText(null), '');
});

t('고치기와 임시 저장', () => {
  const g = DR.createGame({ players: players(3), seed: 4 });
  DR.submit(g, 0, { step: 0, text: '하나' });
  assert.ok(DR.isDone(g, 0));
  assert.ok(DR.unsubmit(g, 0));
  assert.ok(!DR.isDone(g, 0));
  assert.strictEqual(DR.taskFor(g, 0).mine.text, '하나');
  DR.submit(g, 1, { step: 0, text: '임시' }, false);
  assert.ok(!DR.isDone(g, 1));
  const filled = DR.fillMissing(g, () => '아무거나');
  assert.deepStrictEqual(filled.sort(), [0, 1, 2]);
  assert.strictEqual(DR.taskFor(g, 0).mine.text, '하나', '고치던 것도 그대로');
  assert.strictEqual(DR.taskFor(g, 1).mine.text, '임시');
  assert.strictEqual(DR.taskFor(g, 1).mine.auto, false);
  assert.strictEqual(DR.taskFor(g, 2).mine.text, '아무거나');
  assert.strictEqual(DR.taskFor(g, 2).mine.auto, true);
  assert.ok(DR.advance(g));
});

t('시간 초과 채우기: 빈 그림·빈 맞히기, 고른 사람만', () => {
  const g = DR.createGame({ players: players(4), seed: 5 });
  playStep(g);
  DR.submit(g, 0, { step: 1, draw: line() });
  assert.deepStrictEqual(DR.fillMissing(g, () => 'x', [2]), [2]);
  assert.ok(!DR.advance(g));
  DR.fillMissing(g, () => 'x');
  assert.ok(DR.advance(g));
  const t2 = DR.taskFor(g, 0);
  const anyEmpty = [0, 1, 2, 3].map((p) => DR.taskFor(g, p).prev).filter((e) => e.auto);
  assert.strictEqual(anyEmpty.length, 3);
  assert.deepStrictEqual(anyEmpty[0].draw, { ops: [] });
  DR.fillMissing(g, () => 'x');
  assert.strictEqual(DR.taskFor(g, 0).mine.text, '');
  assert.ok(t2);
});

t('끝까지 하면 발표 → 이야기 순서대로 → 끝', () => {
  for (const n of [3, 4, 7]) {
    const g = DR.createGame({ players: players(n), seed: n * 11 });
    for (let s = 0; s < g.steps; s++) playStep(g);
    assert.strictEqual(g.phase, 'reveal');
    assert.deepStrictEqual(g.reveal, { chain: 0, idx: 0 });
    assert.ok(DR.isRevealed(g, 0, 0));
    assert.ok(!DR.isRevealed(g, 0, 1));
    let k = 1;
    let r;
    while ((r = DR.revealNext(g)) && r.type !== 'end') k++;
    assert.strictEqual(k, n * g.steps);
    assert.strictEqual(g.phase, 'end');
    assert.ok(DR.isRevealed(g, n - 1, g.steps - 1));
    // 이야기마다 모든 칸이 차 있고, 칸마다 맡은 사람이 맞음
    for (let c = 0; c < n; c++) for (let s = 0; s < g.steps; s++) {
      const e = g.entries[c][s];
      assert.strictEqual(e.by, DR.seatOf(g, c, s));
      assert.strictEqual(e.kind, DR.kindOf(s));
    }
    const sum = DR.summary(g);
    assert.strictEqual(sum.order.length, n);
    assert.strictEqual(sum.order[0][0], 0);
  }
});

t('남은 칸 한 번에 보기', () => {
  const g = DR.createGame({ players: players(5), seed: 9 });
  for (let s = 0; s < g.steps; s++) playStep(g);
  assert.deepStrictEqual(DR.revealAll(g), { type: 'entry', chain: 0, idx: 4 });
  assert.deepStrictEqual(DR.revealNext(g), { type: 'chain', chain: 1, idx: 0 });
});

t('요약에는 내용이 없음', () => {
  const g = DR.createGame({ players: players(4), seed: 1 });
  DR.submit(g, 0, { step: 0, text: '비밀 제시어' });
  const s = JSON.stringify(DR.summary(g));
  assert.ok(!s.includes('비밀'));
  assert.deepStrictEqual(DR.summary(g).done, [true, false, false, false]);
  assert.strictEqual(DR.summary(g).order, null);
});

t('설정 정리', () => {
  assert.deepStrictEqual(DR.cleanSettings(null, { drawSec: 7, textSec: 30, short: 'yes', mode: 'xx' }), { drawSec: 90, textSec: 30, short: false, mode: 'normal' });
  assert.deepStrictEqual(DR.cleanSettings({ drawSec: 60, textSec: 40, short: true }, { drawSec: 180, mode: 'corpse' }), { drawSec: 180, textSec: 40, short: true, mode: 'corpse' });
});

t('제시어 목록', () => {
  assert.ok(WORDS.ALL.length >= 100);
  assert.strictEqual(new Set(WORDS.ALL).size, WORDS.ALL.length, '겹치는 제시어');
  WORDS.ALL.forEach((w) => assert.strictEqual(DR.cleanText(w), w));
});

t('JSON으로 저장했다 다시 읽어도 그대로 진행', () => {
  let g = DR.createGame({ players: players(4), seed: 12 });
  playStep(g);
  g = JSON.parse(JSON.stringify(g));
  playStep(g);
  assert.strictEqual(g.step, 2);
});


// 한 단계를 모두 냄 (게임 방식에 맞는 칸으로)
function playStepMode(g, draw = (s, step) => line(1 + (s % 10))) {
  for (let s = 0; s < g.n; s++) {
    const k = DR.kindAt(g, g.step);
    const r = DR.submit(g, s, k === 'draw' ? { step: g.step, draw: draw(s, g.step) } : { step: g.step, text: `${k}-${g.step}-${s}` });
    assert.ok(r.ok, JSON.stringify(r));
  }
  assert.ok(DR.advance(g));
}

t('샌드위치: 제시어 → 그림 → 따라 그리기 … → 맞히기', () => {
  for (const n of [3, 4, 6, 7]) {
    const g = DR.createGame({ players: players(n), seed: n, settings: { mode: 'sandwich' } });
    assert.strictEqual(g.steps, n, '짝수여도 칸을 줄이지 않음');
    assert.strictEqual(g.kinds[0], 'prompt');
    assert.strictEqual(g.kinds[n - 1], 'guess');
    for (let s = 1; s < n - 1; s++) assert.strictEqual(g.kinds[s], 'draw');
    playStepMode(g); // 제시어
    playStepMode(g); // 첫 그림
    if (n > 3) {
      const tk = DR.taskFor(g, 0);
      assert.strictEqual(tk.kind, 'draw');
      assert.strictEqual(tk.prev.kind, 'draw', '앞 칸이 그림 → 따라 그리기');
      assert.ok(tk.prev.draw.ops.length);
      assert.ok(DR.submit(g, 0, { step: g.step, text: '글' }).error, '따라 그리기 칸에 글은 안 됨');
    }
    while (g.phase === 'play') {
      if (g.step === g.steps - 1) assert.strictEqual(DR.taskFor(g, 1).kind, 'guess');
      playStepMode(g);
    }
    assert.strictEqual(g.phase, 'reveal');
  }
  assert.strictEqual(DR.stepsFor(9, true, 'sandwich'), 5);
  assert.strictEqual(DR.stepsFor(4, true, 'sandwich'), 4);
});

t('비밀: 진행 순서는 기본과 같음', () => {
  const g = DR.createGame({ players: players(6), seed: 2, settings: { mode: 'secret' } });
  assert.strictEqual(g.mode, 'secret');
  assert.strictEqual(g.steps, 5);
  assert.deepStrictEqual(g.kinds, ['prompt', 'draw', 'guess', 'draw', 'guess']);
  assert.strictEqual(DR.summary(g).mode, 'secret');
  assert.strictEqual(DR.taskFor(g, 0).mode, 'secret');
});

t('정교한 시체: 머리·몸통·다리 3칸, 앞 사람 그림은 아래쪽 띠만', () => {
  for (const n of [3, 5, 12]) {
    const g = DR.createGame({ players: players(n), seed: 9, settings: { mode: 'corpse', short: true } });
    assert.strictEqual(g.steps, 3);
    assert.deepStrictEqual(g.kinds, ['draw', 'draw', 'draw']);
    const t0 = DR.taskFor(g, 0);
    assert.strictEqual(t0.kind, 'draw');
    assert.strictEqual(t0.part, 0);
    assert.strictEqual(t0.prev, null);
    assert.ok(DR.submit(g, 0, { step: 0, text: '머리' }).error, '글은 안 됨');
    // 위쪽에만 그린 선 + 아래 띠까지 내려오는 선 + 채우기
    playStepMode(g, (s) => ({ ops: [
      { c: 2, w: 1, p: [100, 50, 200, 60, 300, 80] },                 // 띠 위 (안 보여야 함)
      { c: 4, w: 2, p: [500, 100, 500, 400, 500, 700, 520, 750] },     // 목: 띠까지 내려옴
      { f: 1, c: 5, x: 500, y: 300 },
    ] }));
    const t1 = DR.taskFor(g, 1);
    assert.strictEqual(t1.part, 1);
    assert.ok(t1.prev.strip);
    const ops = t1.prev.draw.ops;
    assert.strictEqual(ops.length, 1, '띠에 걸친 선 하나만');
    assert.ok(ops.every((o) => !o.f), '채우기는 안 보냄');
    const ys = ops[0].p.filter((_, i) => i % 2);
    assert.ok(Math.min(...ys) >= 400, '띠 바로 위 점 하나까지만: ' + ys);
    assert.deepStrictEqual(ys.slice(-2), [700, 750]);
    // 공개 칸(entries)은 그대로 전부
    assert.strictEqual(g.entries[DR.chainOf(g, 1, 1)][0].draw.ops.length, 3);
    playStepMode(g);
    playStepMode(g);
    assert.strictEqual(g.phase, 'reveal');
    assert.strictEqual(DR.taskFor(g, 0), null);
    // 발표: 그림 하나(머리·몸통·다리)가 한 번에 펼쳐지고, 넘기면 다음 그림
    assert.deepStrictEqual(g.reveal, { chain: 0, idx: 2 });
    assert.ok(DR.isRevealed(g, 0, 2) && !DR.isRevealed(g, 1, 0));
    assert.deepStrictEqual(DR.revealNext(g), { type: 'chain', chain: 1, idx: 2 });
    let k = 1;
    while (DR.revealNext(g).type !== 'end') k++;
    assert.strictEqual(k, n - 1, '그림 수만큼 넘김');
  }
});

t('띠 자르기: 띠를 여러 번 드나드는 선은 조각으로', () => {
  const d = { ops: [{ c: 1, w: 0, p: [0, 700, 10, 100, 20, 720, 30, 730, 40, 50] }] };
  const s = DR.stripOf(d);
  assert.deepStrictEqual(s.ops.map((o) => o.p), [[0, 700, 10, 100], [10, 100, 20, 720, 30, 730, 40, 50]]);
  assert.deepStrictEqual(DR.stripOf({ ops: [{ c: 1, w: 0, p: [5, 5] }] }).ops, []);
  assert.deepStrictEqual(DR.stripOf(null).ops, []);
});

t('시간 초과 채우기는 방식과 상관없이 칸 종류대로', () => {
  const g = DR.createGame({ players: players(4), seed: 4, settings: { mode: 'sandwich' } });
  DR.fillMissing(g, () => '주사위');
  DR.advance(g);
  DR.fillMissing(g, () => 'x');
  DR.advance(g);
  DR.fillMissing(g, () => 'x');
  assert.deepStrictEqual(DR.taskFor(g, 0).mine.draw, { ops: [] });
});

console.log(`규칙 시험 ${passed}개 통과`);
