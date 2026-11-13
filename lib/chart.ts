import type { Sample } from "./foc";

export interface Channel {
  key: keyof Sample;
  color: string;
  dashed?: boolean;
}

/**
 * Backing-store pixels per CSS pixel. Slidev scales the whole slide with a CSS
 * transform, so `clientWidth` is the unscaled size — fold the on-screen scale
 * in, or canvases render at 980-px-slide resolution and blur on a projector.
 */
export function renderScale(el: HTMLElement) {
  const onScreen = el.getBoundingClientRect().width / (el.clientWidth || 1);
  return Math.min(devicePixelRatio * (onScreen || 1), 4);
}

/** Round up to 1/2/5 × 10ⁿ. */
function niceCeil(value: number) {
  const exp = 10 ** Math.floor(Math.log10(value));
  const m = value / exp;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * exp;
}

/** Scrolling strip chart over the last `window` seconds of model time, auto-ranged. */
export class StripChart {
  private context: CanvasRenderingContext2D;
  private extent: number;

  constructor(
    private canvas: HTMLCanvasElement,
    private channels: Channel[],
    private minExtent: number,
  ) {
    this.context = canvas.getContext("2d")!;
    this.extent = minExtent;
  }

  draw(history: Sample[], now: number, window: number) {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    const dpr = renderScale(this.canvas);
    if (this.canvas.width !== Math.round(width * dpr)) this.canvas.width = Math.round(width * dpr);
    if (this.canvas.height !== Math.round(height * dpr))
      this.canvas.height = Math.round(height * dpr);

    let peak = 0;
    for (const point of history) {
      if (point.time < now - window) continue;
      for (const channel of this.channels) {
        const value = point[channel.key];
        if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
      }
    }
    // Grow at once, shrink only when the signal is well inside the range.
    const wanted = niceCeil(Math.max(this.minExtent, peak * 1.1));
    if (wanted > this.extent || wanted < this.extent / 2.5) this.extent = wanted;

    const c = this.context;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, width, height);
    const left = 30;
    const right = width - 6;
    const top = 5;
    const bottom = height - 5;
    const middle = (top + bottom) / 2;
    const scale = (bottom - top) / (this.extent * 2);

    c.font = '9px "IBM Plex Mono", ui-monospace, monospace';
    c.textAlign = "right";
    c.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = top + ((bottom - top) * i) / 4;
      c.strokeStyle = i === 2 ? "#b9c4cd" : "#e4e9ed";
      c.beginPath();
      c.moveTo(left, y);
      c.lineTo(right, y);
      c.stroke();
      if (i % 2 === 0) {
        c.fillStyle = "#7d8b97";
        c.fillText(String((1 - i / 2) * this.extent), left - 5, y + 3);
      }
    }

    c.save();
    c.beginPath();
    c.rect(left, top - 2, right - left + 3, bottom - top + 4);
    c.clip();
    const x = (t: number) => right - ((now - t) / window) * (right - left);
    for (const channel of this.channels) {
      c.strokeStyle = channel.color;
      c.lineWidth = 1.5;
      c.setLineDash(channel.dashed ? [4, 4] : []);
      c.beginPath();
      let started = false;
      for (const point of history) {
        if (point.time < now - window) continue;
        const value = point[channel.key];
        if (!Number.isFinite(value)) {
          started = false;
          continue;
        }
        const y = middle - value * scale;
        if (started) c.lineTo(x(point.time), y);
        else c.moveTo(x(point.time), y);
        started = true;
      }
      c.stroke();
    }
    c.restore();
  }
}
