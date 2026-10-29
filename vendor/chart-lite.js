/*!
 * chart-lite.js —— 不超过 300 行、零依赖的 Canvas 图表
 * 只实现本项目用到的 Chart.js 子集：折线（带填充/平滑）、分组柱状、图例、坐标轴、点按提示。
 * 用法与 Chart.js 兼容：new Chart(ctx, config)  以及 chart.destroy()
 * 之所以自带而不引 CDN：离线、弱网、内网部署时不能白屏。
 */
(function (global) {
  'use strict';

  const FONT = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  const FONT_LEGEND = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

  function niceCeil(v) {
    if (!isFinite(v) || v <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nice * exp;
  }

  function withAlpha(color, alpha) {
    if (typeof color !== 'string') return `rgba(0,0,0,${alpha})`;
    if (color.startsWith('#')) {
      let h = color.slice(1);
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      const n = parseInt(h, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }
    if (color.startsWith('rgba')) {
      const parts = color.slice(5, -1).split(',').map((s) => s.trim());
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }
    return color;
  }

  function textWidth(ctx, text, font) {
    const prev = ctx.font;
    ctx.font = font;
    const w = ctx.measureText(text).width;
    ctx.font = prev;
    return w;
  }

  class ChartLite {
    constructor(target, config) {
      this.canvas = target && target.canvas ? target.canvas : target;
      this.ctx = this.canvas.getContext('2d');
      this.config = config || {};
      this.hover = -1;
      this._destroyed = false;
      this._raf = 0;

      this._onMove = (ev) => this._handlePointer(ev);
      this._onLeave = () => {
        if (this.hover !== -1) {
          this.hover = -1;
          this.draw();
        }
      };
      this._onResize = () => {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
          this._raf = 0;
          this.draw();
        });
      };

      this.canvas.style.touchAction = 'pan-y';
      this.canvas.addEventListener('pointermove', this._onMove, { passive: true });
      this.canvas.addEventListener('pointerdown', this._onMove, { passive: true });
      this.canvas.addEventListener('pointerleave', this._onLeave, { passive: true });
      this.canvas.addEventListener('pointercancel', this._onLeave, { passive: true });

      if (typeof ResizeObserver === 'function' && this.canvas.parentElement) {
        this._ro = new ResizeObserver(this._onResize);
        this._ro.observe(this.canvas.parentElement);
      } else {
        global.addEventListener('resize', this._onResize);
      }
      this.draw();
    }

    destroy() {
      this._destroyed = true;
      if (this._raf) cancelAnimationFrame(this._raf);
      this.canvas.removeEventListener('pointermove', this._onMove);
      this.canvas.removeEventListener('pointerdown', this._onMove);
      this.canvas.removeEventListener('pointerleave', this._onLeave);
      this.canvas.removeEventListener('pointercancel', this._onLeave);
      if (this._ro) this._ro.disconnect();
      else global.removeEventListener('resize', this._onResize);
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.canvas.width = 0;
      this.canvas.height = 0;
    }

    // ── 布局计算 ──────────────────────────────────────────────
    _layout(w, h) {
      const type = this.config.type;
      const isBar = type === 'bar';
      const legend = this.config.options?.plugins?.legend;
      const showLegend = legend ? legend.display !== false : true;
      const legendH = showLegend ? 22 : 4;

      const maxTicks = this.config.options?.scales?.x?.ticks?.maxTicksLimit || (isBar ? 12 : 15);
      const labels = this.config.data.labels || [];
      const datasets = this.config.data.datasets || [];

      let maxVal = 0;
      for (const ds of datasets) {
        for (const v of ds.data || []) {
          const n = Number(v) || 0;
          if (n > maxVal) maxVal = n;
        }
      }
      const yMax = niceCeil(maxVal);
      const padL = 34;
      const padR = 8;
      const padB = 18;
      const plot = {
        left: padL,
        right: w - padR,
        top: legendH + 6,
        bottom: h - padB,
      };
      plot.width = Math.max(1, plot.right - plot.left);
      plot.height = Math.max(1, plot.bottom - plot.top);

      const n = labels.length;
      const band = n ? plot.width / n : plot.width;

      // x 轴标签抽样
      const xTickStep = Math.max(1, Math.ceil(n / maxTicks));

      return { isBar, labels, datasets, yMax, plot, band, n, showLegend, legendH, xTickStep };
    }

    _xOf(L, i, mid = true) {
      return L.plot.left + L.band * i + (mid ? L.band / 2 : 0);
    }

    _yOf(L, v) {
      const ratio = L.yMax ? Math.max(0, Math.min(1, v / L.yMax)) : 0;
      return L.plot.bottom - ratio * L.plot.height;
    }

    // ── 主绘制 ────────────────────────────────────────────────
    draw() {
      if (this._destroyed) return;
      const canvas = this.canvas;
      const parent = canvas.parentElement;
      const cssW = Math.max(1, Math.floor((parent ? parent.clientWidth : canvas.clientWidth) || 300));
      const cssH = Math.max(1, Math.floor((parent ? parent.clientHeight : canvas.clientHeight) || 200));
      const dpr = Math.min(global.devicePixelRatio || 1, 3);

      if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);
      }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const L = this._layout(cssW, cssH);
      if (!L.n) return;

      this._drawAxes(ctx, L, cssW, cssH);
      if (L.isBar) this._drawBars(ctx, L);
      else this._drawLines(ctx, L);
      if (L.showLegend) this._drawLegend(ctx, L, cssW);
      this._drawTooltip(ctx, L, cssW, cssH);
    }

    _drawAxes(ctx, L, w, h) {
      const { plot, yMax, labels, xTickStep } = L;
      ctx.font = FONT;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';

      const steps = 4;
      for (let i = 0; i <= steps; i++) {
        const val = (yMax / steps) * i;
        const y = Math.round(plot.bottom - (i / steps) * plot.height) + 0.5;
        ctx.strokeStyle = i === 0 ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.right, y);
        ctx.stroke();

        ctx.fillStyle = '#94a3b8';
        const text = '¥' + (val >= 1000 ? Math.round(val) : Math.round(val * 100) / 100);
        ctx.fillText(text, plot.left - 6, y);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#94a3b8';
      for (let i = 0; i < labels.length; i += xTickStep) {
        const x = this._xOf(L, i);
        const label = String(labels[i]);
        if (textWidth(ctx, label, FONT) > L.band * xTickStep - 2) continue;
        ctx.fillText(label, x, plot.bottom + 4);
      }
    }

    _drawBars(ctx, L) {
      const { datasets, plot, band } = L;
      const groupW = Math.max(2, Math.min(26, band * 0.68));
      const barW = Math.max(1.5, groupW / datasets.length);
      const radius = 2;

      datasets.forEach((ds, di) => {
        ctx.fillStyle = ds.backgroundColor || ds.borderColor || '#3b82f6';
        (ds.data || []).forEach((v, i) => {
          const val = Number(v) || 0;
          if (val <= 0) return;
          const x = this._xOf(L, i) - groupW / 2 + di * barW;
          const y = this._yOf(L, val);
          const hgt = Math.max(1, plot.bottom - y);
          const bw = Math.max(1, barW - 1.5);
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x, y, bw, hgt, [radius, radius, 0, 0]);
          else ctx.rect(x, y, bw, hgt);
          ctx.fill();
        });
      });
    }

    _drawLines(ctx, L) {
      const { datasets, plot } = L;
      datasets.forEach((ds) => {
        const pts = (ds.data || []).map((v, i) => ({
          x: this._xOf(L, i),
          y: this._yOf(L, Number(v) || 0),
        }));
        if (!pts.length) return;

        const path = new Path2D();
        path.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          const p0 = pts[i - 1];
          const p1 = pts[i];
          const midX = (p0.x + p1.x) / 2;
          path.bezierCurveTo(midX, p0.y, midX, p1.y, p1.x, p1.y);
        }

        if (ds.fill) {
          const fillPath = new Path2D(path);
          fillPath.lineTo(pts[pts.length - 1].x, plot.bottom);
          fillPath.lineTo(pts[0].x, plot.bottom);
          fillPath.closePath();
          ctx.fillStyle = typeof ds.backgroundColor === 'string' && ds.backgroundColor.startsWith('rgba')
            ? withAlpha(ds.borderColor || ds.backgroundColor, 0.12)
            : withAlpha(ds.borderColor, 0.12);
          ctx.fill(fillPath);
        }

        ctx.strokeStyle = ds.borderColor || '#3b82f6';
        ctx.lineWidth = ds.borderWidth || 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke(path);

        const r = ds.pointRadius || 0;
        if (r > 0) {
          ctx.fillStyle = ds.pointBackgroundColor || ds.borderColor;
          pts.forEach((p) => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fill();
          });
        }
      });
    }

    _drawLegend(ctx, L, w) {
      const { datasets } = L;
      ctx.font = FONT_LEGEND;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      const items = datasets.map((ds) => ({
        label: ds.label || '',
        color: ds.borderColor || ds.backgroundColor || '#333',
        w: 10 + 6 + textWidth(ctx, ds.label || '', FONT_LEGEND),
      }));
      const total = items.reduce((s, it) => s + it.w + 14, -14);
      let x = Math.max(4, (w - total) / 2);
      const y = 11;
      items.forEach((it) => {
        ctx.fillStyle = it.color;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y - 5, 10, 10, 3);
        else ctx.rect(x, y - 5, 10, 10);
        ctx.fill();
        ctx.fillStyle = '#64748b';
        ctx.fillText(it.label, x + 16, y + 0.5);
        x += it.w + 14;
      });
    }

    _drawTooltip(ctx, L, w, h) {
      if (this.hover < 0 || this.hover >= L.n) return;
      const x = this._xOf(L, this.hover);

      ctx.save();
      ctx.strokeStyle = 'rgba(59,130,246,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, L.plot.top);
      ctx.lineTo(Math.round(x) + 0.5, L.plot.bottom);
      ctx.stroke();
      ctx.restore();

      const label = String(L.labels[this.hover]);
      const lines = L.datasets.map((ds) => ({
        color: ds.borderColor || ds.backgroundColor || '#333',
        text: `${ds.label}: ¥${(Number(ds.data[this.hover]) || 0).toFixed(2)}`,
      }));

      ctx.font = FONT;
      const titleW = textWidth(ctx, label, FONT);
      const lineW = Math.max(...lines.map((l) => textWidth(ctx, l.text, FONT)), titleW);
      const boxW = Math.max(78, lineW + 20);
      const boxH = 18 + lines.length * 15 + 4;
      let bx = x + 10;
      if (bx + boxW > w - 4) bx = x - 10 - boxW;
      bx = Math.max(4, bx);
      let by = L.plot.top + 2;
      if (by + boxH > L.plot.bottom) by = L.plot.bottom - boxH;

      ctx.save();
      ctx.fillStyle = 'rgba(30,41,59,0.92)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 6);
      else ctx.rect(bx, by, boxW, boxH);
      ctx.fill();

      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 10, by + 11);
      lines.forEach((l, i) => {
        const ty = by + 26 + i * 15;
        ctx.fillStyle = l.color;
        ctx.beginPath();
        ctx.arc(bx + 12, ty, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(l.text, bx + 20, ty);
      });
      ctx.restore();
    }

    _handlePointer(ev) {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width) return;
      const parent = this.canvas.parentElement;
      const cssW = parent ? parent.clientWidth : rect.width;
      const cssH = parent ? parent.clientHeight : rect.height;
      const L = this._layout(cssW, cssH);
      const px = ev.clientX - rect.left;
      if (!L.n || px < L.plot.left - L.band / 2 || px > L.plot.right + L.band / 2) {
        if (this.hover !== -1) {
          this.hover = -1;
          this.draw();
        }
        return;
      }
      const idx = Math.max(0, Math.min(L.n - 1, Math.floor((px - L.plot.left) / L.band)));
      if (idx !== this.hover) {
        this.hover = idx;
        this.draw();
      }
    }
  }

  global.Chart = ChartLite;
  if (typeof module !== 'undefined' && module.exports) module.exports = ChartLite;
})(typeof window !== 'undefined' ? window : globalThis);
