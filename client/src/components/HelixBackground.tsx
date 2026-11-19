import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { cn } from '~/utils';

/**
 * OmicsBase: a slowly turning DNA double helix drawn behind the signed-out
 * pages (welcome, log in, sign up). It follows the light/dark class on <html>,
 * tilts a little with the pointer and holds still for readers who ask for
 * reduced motion.
 */

type Palette = {
  strandA: string;
  strandB: string;
  rungs: [string, string][];
  dot: string;
  alpha: { rung: number; node: number; strand: number };
};

const LIGHT: Palette = {
  strandA: '#1c5757',
  strandB: '#0c6b99',
  rungs: [
    ['#1c5757', '#b33b50'],
    ['#9a6510', '#186c96'],
  ],
  dot: '#1c5757',
  alpha: { rung: 0.5, node: 0.72, strand: 0.62 },
};

const DARK: Palette = {
  strandA: '#63ccc0',
  strandB: '#38bdf8',
  rungs: [
    ['#63ccc0', '#e07a8a'],
    ['#deb266', '#7dd3fc'],
  ],
  dot: '#63ccc0',
  alpha: { rung: 0.68, node: 0.9, strand: 0.82 },
};

const STEPS = 72;
const TURN = 0.36;
const GROOVE = 2.35;
const FOV = 920;

type Point = { x: number; y: number; z: number; scale: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function drawHelix(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  time: number,
  pointer: { x: number; y: number },
  p: Palette,
  scroll: number,
  speed: number,
) {
  ctx.clearRect(0, 0, w, h);
  const radius = Math.min(w, h) * 0.19;
  const pitch = Math.hypot(w, h) / 56;
  /* As in the landing reference, scrolling turns the helix and flies along it. */
  const tiltZ = Math.atan2(w * 0.85, h) - scroll * 0.12 + pointer.x * 0.1;
  const tiltX = 0.24 + pointer.y * 0.2;
  const spin = time * 0.00055 * speed + scroll * Math.PI * 3.2;
  const flight = scroll * 14;
  const step = Math.floor(flight);
  const frac = flight % 1;
  const cz = Math.cos(tiltZ);
  const sz = Math.sin(tiltZ);
  const cx = Math.cos(tiltX);
  const sx = Math.sin(tiltX);

  const project = (x: number, y: number, z: number): Point => {
    const y1 = y * cx - z * sx;
    const z1 = y * sx + z * cx;
    const scale = FOV / (FOV - z1);
    return {
      x: w / 2 + (x * cz - y1 * sz) * scale,
      y: h / 2 + (x * sz + y1 * cz) * scale,
      z: z1,
      scale,
    };
  };

  const queue: { z: number; draw: () => void }[] = [];
  let prevA: Point | null = null;
  let prevB: Point | null = null;

  for (let i = 0; i < STEPS; i++) {
    const y = (i - STEPS / 2 + frac) * pitch;
    const phase = (i + step) * TURN + spin - frac * TURN;
    const ax = Math.cos(phase) * radius;
    const az = Math.sin(phase) * radius;
    const bx = Math.cos(phase + GROOVE) * radius;
    const bz = Math.sin(phase + GROOVE) * radius;
    const a = project(ax, y, az);
    const b = project(bx, y, bz);
    const m = project((ax + bx) / 2, y, (az + bz) / 2);
    const [c1, c2] = p.rungs[Math.abs(i + step) % 2];

    queue.push({
      z: (a.z + m.z) / 2,
      draw: () => {
        ctx.globalAlpha = clamp(0.45 + m.z / (radius * 2.2), 0.14, 0.85) * p.alpha.rung;
        ctx.lineWidth = Math.max(1.2, 2.4 * m.scale);
        ctx.strokeStyle = c1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(m.x, m.y);
        ctx.stroke();
        ctx.strokeStyle = c2;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.fillStyle = p.dot;
        ctx.beginPath();
        ctx.arc(m.x, m.y, Math.max(1.4, 2.3 * m.scale), 0, Math.PI * 2);
        ctx.fill();
      },
    });

    for (const [pt, prev, colour] of [
      [a, prevA, p.strandA],
      [b, prevB, p.strandB],
    ] as [Point, Point | null, string][]) {
      queue.push({
        z: pt.z + 2,
        draw: () => {
          ctx.globalAlpha = clamp(0.52 + pt.z / (radius * 2), 0.2, 0.95) * p.alpha.node;
          ctx.fillStyle = colour;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, Math.max(2.2, 4.4 * pt.scale), 0, Math.PI * 2);
          ctx.fill();
        },
      });
      if (prev) {
        queue.push({
          z: (prev.z + pt.z) / 2,
          draw: () => {
            ctx.globalAlpha = clamp(0.5 + pt.z / (radius * 2), 0.18, 0.92) * p.alpha.strand;
            ctx.strokeStyle = colour;
            ctx.lineWidth = Math.max(1.8, 3.4 * pt.scale);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(pt.x, pt.y);
            ctx.stroke();
          },
        });
      }
    }
    prevA = a;
    prevB = b;
  }

  queue.sort((q1, q2) => q1.z - q2.z).forEach((q) => q.draw());
  ctx.globalAlpha = 1;
}

type Props = {
  /** A scrolling element whose position turns the helix, as on the landing page. */
  scrollRef?: RefObject<HTMLElement>;
  /** Rotation speed; 1 is the welcome page's, one turn in about eleven seconds. */
  speed?: number;
  /** Fades the helix out when false and stops drawing it once the fade is over. */
  visible?: boolean;
};

/** Length of the fade, in ms; matches the duration class on the wrapper. */
const FADE_MS = 700;

export default function HelixBackground({ scrollRef, speed = 1, visible = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const shown = useRef({ visible, hiddenAt: 0 });
  const restart = useRef<() => void>(() => undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      return;
    }
    const root = document.documentElement;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = { x: 0, y: 0 };
    let w = 0;
    let h = 0;
    let frame = 0;
    let scroll = 0;

    /* Eases toward the scroll position, so the helix glides rather than jumps. */
    const scrollTarget = () => {
      const el = scrollRef?.current;
      if (!el) {
        return 0;
      }
      return Math.min(1, el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight));
    };
    const draw = (time: number) => {
      scroll += (scrollTarget() - scroll) * 0.08;
      const palette = root.classList.contains('dark') ? DARK : LIGHT;
      drawHelix(ctx, w, h, time, pointer, palette, scroll, speedRef.current);
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(performance.now());
    };

    /* Once hidden and faded out, the helix stops drawing until it is shown again. */
    const tick = (time: number) => {
      draw(time);
      const { visible: on, hiddenAt } = shown.current;
      frame = on || time - hiddenAt < FADE_MS ? requestAnimationFrame(tick) : 0;
    };
    const start = () => {
      cancelAnimationFrame(frame);
      if (still.matches) {
        draw(0);
      } else {
        frame = requestAnimationFrame(tick);
      }
    };

    const onPointer = (e: PointerEvent) => {
      pointer.x = e.clientX / window.innerWidth - 0.5;
      pointer.y = e.clientY / window.innerHeight - 0.5;
    };

    /* Redraw at once when the theme flips, so a still helix changes colour too. */
    const themeObserver = new MutationObserver(() => draw(still.matches ? 0 : performance.now()));
    themeObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(canvas);
    window.addEventListener('pointermove', onPointer, { passive: true });
    still.addEventListener('change', start);
    restart.current = start;
    resize();
    start();

    return () => {
      cancelAnimationFrame(frame);
      themeObserver.disconnect();
      sizeObserver.disconnect();
      window.removeEventListener('pointermove', onPointer);
      still.removeEventListener('change', start);
    };
  }, [scrollRef]);

  useEffect(() => {
    shown.current = { visible, hiddenAt: visible ? 0 : performance.now() };
    if (visible) {
      restart.current();
    }
  }, [visible]);

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-0 overflow-hidden transition-opacity duration-700',
        !visible && 'opacity-0',
      )}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
