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

t('짧게 하기는 최대 6단계', () => {
  assert.strictEqual(DR.createGame({ players: players(9), seed: 3, settings: { short: true } }).steps, 6);
  assert.strictEqual(DR.createGame({ players: players(4), seed: 3, settings: { short: true } }).steps, 4);
  assert.strictEqual(DR.createGame({ players: players(9), seed: 3 }).steps, 9);
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
  assert.deepStrictEqual(DR.cleanSettings(null, { drawSec: 7, textSec: 30, short: 'yes' }), { drawSec: 90, textSec: 30, short: false });
  assert.deepStrictEqual(DR.cleanSettings({ drawSec: 60, textSec: 40, short: true }, { drawSec: 180 }), { drawSec: 180, textSec: 40, short: true });
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

console.log(`규칙 시험 ${passed}개 통과`);
