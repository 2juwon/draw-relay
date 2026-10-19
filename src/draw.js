/* 그림판과 그림 그리기
 * - 그림은 { ops: [선 {c,w,p} | 채우기 {f:1,c,x,y}] } (좌표 1000×750, 색·굵기는 번호)
 * - render(): 다 그리기 / replay(): 그린 순서대로 다시 보여 주기 / Pad: 손가락·마우스로 그리기
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DRAW = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 1000, H = 750;
  const PALETTE = [
    '#ffffff', '#1d1b19', '#8a8580', '#cfcac2', '#e5383b', '#ff8fab', '#ff8c1a', '#ffd23f', '#9bd33a',
    '#2bb673', '#1fa39a', '#5cc8ff', '#2667ff', '#1d3a8a', '#8f5bd8', '#8a5a3b', '#f6c9a0', '#e8d5b0',
  ];
  const SIZES = [4, 9, 18, 34, 60];

  function strokePath(ctx, p, n) {
    // n: 앞에서부터 몇 점까지 그릴지 (다시 보여 주기용)
    const count = Math.min(n == null ? p.length / 2 : n, p.length / 2);
    if (count <= 0) return;
    ctx.beginPath();
    if (count === 1) {
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[0] + 0.01, p[1]);
    } else {
      ctx.moveTo(p[0], p[1]);
      for (let i = 1; i < count - 1; i++) {
        const x = p[i * 2], y = p[i * 2 + 1];
        const nx = p[i * 2 + 2], ny = p[i * 2 + 3];
        ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
      }
      ctx.lineTo(p[(count - 1) * 2], p[(count - 1) * 2 + 1]);
    }
    ctx.stroke();
  }

  function drawStroke(ctx, o, n) {
    ctx.strokeStyle = PALETTE[o.c] || '#000';
    ctx.lineWidth = SIZES[o.w] || 9;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokePath(ctx, o.p, n);
  }

  function hexRgb(h) { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }

  // 채우기: 누른 곳과 비슷한 색이 이어진 곳을 칠함 (경계의 흐린 픽셀까지 조금 넘쳐 칠해 틈이 안 보이게)
  function floodFill(ctx, o) {
    const cv = ctx.canvas;
    const k = cv.width / W;
    const sx = Math.max(0, Math.min(cv.width - 1, Math.floor(o.x * k)));
    const sy = Math.max(0, Math.min(cv.height - 1, Math.floor(o.y * k)));
    const w = cv.width, h = cv.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const i0 = (sy * w + sx) * 4;
    const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2];
    const [fr, fg, fb] = hexRgb(PALETTE[o.c] || '#000000');
    if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 6) return;
    const TOL = 110;
    const near = (j) => Math.abs(d[j] - tr) + Math.abs(d[j + 1] - tg) + Math.abs(d[j + 2] - tb) <= TOL;
    const seen = new Uint8Array(w * h);
    const stack = [sx, sy];
    const edge = [];
    while (stack.length) {
      const y = stack.pop(), x0 = stack.pop();
      let x = x0;
      let idx = y * w + x;
      while (x >= 0 && !seen[idx] && near(idx * 4)) { x--; idx--; }
      x++; idx++;
      let up = false, down = false;
      while (x < w && !seen[idx] && near(idx * 4)) {
        seen[idx] = 1;
        const j = idx * 4;
        d[j] = fr; d[j + 1] = fg; d[j + 2] = fb; d[j + 3] = 255;
        if (y > 0) {
          const u = idx - w;
          if (!seen[u] && near(u * 4)) { if (!up) { stack.push(x, y - 1); up = true; } } else { up = false; if (!seen[u]) edge.push(u); }
        }
        if (y < h - 1) {
          const v = idx + w;
          if (!seen[v] && near(v * 4)) { if (!down) { stack.push(x, y + 1); down = true; } } else { down = false; if (!seen[v]) edge.push(v); }
        }
        x++; idx++;
      }
      if (x < w && !seen[idx]) edge.push(idx);
      if (x0 > 0) { const l = y * w + Math.max(0, x0 - 1); if (!seen[l]) edge.push(l); }
    }
    // 테두리 한 줄 더 칠하기 (선의 흐린 가장자리와 사이 틈 메우기)
    for (const e of edge) {
      const j = e * 4;
      if (seen[e]) continue;
      // 원래 선 색이 진하면 반쯤만 섞음
      d[j] = (d[j] + fr) >> 1; d[j + 1] = (d[j + 1] + fg) >> 1; d[j + 2] = (d[j + 2] + fb) >> 1; d[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function prepare(ctx) {
    const cv = ctx.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const k = cv.width / W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
  }
  function applyOp(ctx, o, n) {
    if (o.clear) { prepare(ctx); return; }
    if (o.f) { const t = ctx.getTransform(); ctx.setTransform(1, 0, 0, 1, 0, 0); floodFill(ctx, o); ctx.setTransform(t); return; }
    drawStroke(ctx, o, n);
  }
  function render(ctx, ops) {
    prepare(ctx);
    for (const o of ops || []) applyOp(ctx, o);
  }

  // 캔버스 크기를 화면 크기에 맞춤 (가로세로 4:3, 선명도는 기기 화소에 맞추되 너무 크지 않게)
  function fit(cv, cssW) {
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    const pxW = Math.round(Math.max(320, Math.min(1400, cssW * dpr)));
    const pxH = Math.round(pxW * H / W);
    if (cv.width !== pxW || cv.height !== pxH) { cv.width = pxW; cv.height = pxH; return true; }
    return false;
  }

  // 그린 순서대로 다시 보여 주기. 길이에 맞춰 1.2~5초
  function replay(ctx, ops, opts = {}) {
    ops = ops || [];
    let total = 0;
    const weights = ops.map((o) => (o.f ? 6 : Math.max(2, o.p.length / 2)));
    weights.forEach((w) => { total += w; });
    const dur = opts.duration || Math.max(1200, Math.min(5000, total * 9));
    const start = performance.now();
    let stopped = false;
    let doneIdx = 0;   // 끝까지 그린 op 수
    prepare(ctx);
    return new Promise((resolve) => {
      function frame(now) {
        if (stopped) return resolve(false);
        const t = Math.min(1, (now - start) / dur);
        const target = t * total;
        // 이미 끝난 op는 다시 안 그림. 지금 그리는 op만 다시 그림 → 끝난 그림 위에 겹치므로 스냅샷 사용
        let acc = 0;
        for (let i = 0; i < doneIdx; i++) acc += weights[i];
        while (doneIdx < ops.length && acc + weights[doneIdx] <= target) {
          applyOp(ctx, ops[doneIdx]);
          acc += weights[doneIdx];
          doneIdx++;
          snap = null;
        }
        if (doneIdx < ops.length && !ops[doneIdx].f && !ops[doneIdx].clear) {
          const o = ops[doneIdx];
          const n = Math.floor(((target - acc) / weights[doneIdx]) * (o.p.length / 2));
          if (n > 0) {
            if (!snap) snap = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
            else ctx.putImageData(snap, 0, 0);
            drawStroke(ctx, o, n);
          }
        }
        if (t >= 1) { render(ctx, ops); return resolve(true); }
        requestAnimationFrame(frame);
      }
      let snap = null;
      requestAnimationFrame(frame);
      if (opts.signal) opts.signal.addEventListener('abort', () => { stopped = true; render(ctx, ops); });
    });
  }

  /* ── 그림판 ── */
  class Pad {
    constructor(canvas, opts = {}) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d', { willReadFrequently: true });
      this.ops = [];        // 지우기({clear:1})도 들어감. 낼 때는 마지막 지우기 뒤만
      this.redo = [];
      this.tool = 'pen';
      this.color = 1;
      this.size = 1;
      this.cur = null;
      this.onChange = opts.onChange || (() => {});
      this.readOnly = false;
      this.base = null;     // 지금까지 그린 것 스냅샷 (선 그리는 중에 다시 깔기용)
      // 비밀 모드: 그은 선이 잠깐 보였다가 사라짐 (그림은 그대로 남고 화면에서만 지움)
      this.secret = !!opts.secret;
      this.born = new WeakMap();
      this.fadeRaf = 0;
      const down = (e) => this.down(e);
      const move = (e) => this.move(e);
      const up = (e) => this.up(e);
      canvas.addEventListener('pointerdown', down);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      this.resize();
    }
    resize() {
      const w = this.cv.getBoundingClientRect().width || 600;
      fit(this.cv, w);
      this.redraw();
    }
    redraw() { if (this.secret) { this.paintSecret(); return; } render(this.ctx, this.ops); this.base = null; }
    paintSecret() {
      const HOLD = 500, FADE = 1300;
      const now = performance.now();
      prepare(this.ctx);
      let k = -1;
      this.ops.forEach((o, i) => { if (o.clear) k = i; });
      let alive = false;
      for (let i = k + 1; i < this.ops.length; i++) {
        const o = this.ops[i];
        const t0 = this.born.get(o);
        if (t0 == null) continue;
        const age = now - t0;
        if (age >= HOLD + FADE) continue;
        alive = true;
        this.ctx.globalAlpha = age < HOLD ? 1 : 1 - (age - HOLD) / FADE;
        if (o.f) { // 채우기는 누른 자리에 동그라미로만 잠깐 표시
          this.ctx.fillStyle = PALETTE[o.c] || '#000';
          this.ctx.beginPath(); this.ctx.arc(o.x, o.y, 46, 0, Math.PI * 2); this.ctx.fill();
          this.ctx.lineWidth = 3; this.ctx.strokeStyle = '#1d1b19'; this.ctx.stroke();
        } else drawStroke(this.ctx, o);
      }
      this.ctx.globalAlpha = 1;
      if (this.cur) drawStroke(this.ctx, this.cur);
      cancelAnimationFrame(this.fadeRaf);
      this.fadeRaf = alive ? requestAnimationFrame(() => this.paintSecret()) : 0;
    }
    point(e) {
      const r = this.cv.getBoundingClientRect();
      return [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * H)];
    }
    down(e) {
      if (this.readOnly || (e.button != null && e.button > 0)) return;
      e.preventDefault();
      const [x, y] = this.point(e);
      if (this.tool === 'fill') {
        this.push({ f: 1, c: this.color, x: Math.max(0, Math.min(W, x)), y: Math.max(0, Math.min(H, y)) });
        if (this.secret) this.paintSecret();
        else applyOp(this.ctx, this.ops[this.ops.length - 1]);
        return;
      }
      try { this.cv.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
      this.cur = { c: this.tool === 'eraser' ? 0 : this.color, w: this.size, p: [x, y], id: e.pointerId };
      if (this.secret) { this.paintSecret(); return; }
      this.base = this.ctx.getImageData(0, 0, this.cv.width, this.cv.height);
      drawStroke(this.ctx, this.cur);
    }
    move(e) {
      if (!this.cur || e.pointerId !== this.cur.id) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const p = this.cur.p;
      for (const ev of evs.length ? evs : [e]) {
        const [x, y] = this.point(ev);
        const lx = p[p.length - 2], ly = p[p.length - 1];
        if ((x - lx) * (x - lx) + (y - ly) * (y - ly) < 9) continue; // 3 이내는 건너뜀
        p.push(x, y);
      }
      if (this.secret) { if (!this.fadeRaf) this.paintSecret(); return; }
      this.ctx.putImageData(this.base, 0, 0);
      drawStroke(this.ctx, this.cur);
    }
    up(e) {
      if (!this.cur || (e && e.pointerId !== this.cur.id)) return;
      const o = this.cur;
      this.cur = null;
      this.base = null;
      const W2 = W, H2 = H;
      o.p = o.p.map((v, i) => Math.max(0, Math.min(i % 2 ? H2 : W2, v)));
      delete o.id;
      this.push(o);
    }
    push(o) { this.ops.push(o); this.redo = []; if (this.secret) { this.born.set(o, performance.now()); this.paintSecret(); } this.onChange(); }
    undo() { if (!this.ops.length) return; this.redo.push(this.ops.pop()); this.redraw(); this.onChange(); }
    again() { if (!this.redo.length) return; this.ops.push(this.redo.pop()); this.redraw(); this.onChange(); }
    clear() { if (!this.drawing().ops.length) return; this.push({ clear: 1 }); this.redraw(); }
    load(ops) { this.ops = (ops || []).slice(); this.redo = []; this.redraw(); }
    // 낼 그림: 마지막 '모두 지우기' 뒤만
    drawing() {
      let k = -1;
      this.ops.forEach((o, i) => { if (o.clear) k = i; });
      return { ops: this.ops.slice(k + 1).map((o) => (o.f ? { f: 1, c: o.c, x: o.x, y: o.y } : { c: o.c, w: o.w, p: o.p })) };
    }
    pointCount() { return this.drawing().ops.reduce((n, o) => n + (o.p ? o.p.length / 2 : 0), 0); }
  }

  // 정교한 시체: 그림의 아래쪽 띠(y ≥ top)만 그려 보여 주기. 캔버스 높이는 띠 높이에 맞춤
  function renderStrip(cv, ops, top, cssW) {
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    const pxW = Math.round(Math.max(320, Math.min(1400, cssW * dpr)));
    const pxH = Math.round(pxW * (H - top) / W);
    if (cv.width !== pxW || cv.height !== pxH) { cv.width = pxW; cv.height = pxH; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const k = cv.width / W;
    ctx.setTransform(k, 0, 0, k, 0, -top * k);
    for (const o of ops || []) if (!o.f) drawStroke(ctx, o);
  }

  // 그림을 이미지로 (앨범 저장용)
  function toCanvas(ops, width) {
    const cv = document.createElement('canvas');
    cv.width = width; cv.height = Math.round(width * H / W);
    render(cv.getContext('2d', { willReadFrequently: true }), ops);
    return cv;
  }

  return { W, H, PALETTE, SIZES, render, replay, fit, Pad, toCanvas, renderStrip };
});
