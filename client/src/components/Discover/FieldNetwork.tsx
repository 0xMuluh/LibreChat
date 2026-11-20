import { useEffect, useRef, useState } from 'react';
import type { FieldNode } from './fields';
import { FIELD_NODES, HUB_NODE, nodeShort } from './fields';
import { useLocalize } from '~/hooks';

const NODES = [HUB_NODE, ...FIELD_NODES];

/** Canvas colours per theme, from the landing reference: edges, node faces, marks and labels (lit, linked, other). */
const INK = {
  light: {
    faint: 'rgba(28, 87, 87, 0.16)',
    face: 'rgba(255, 255, 255, 0.94)',
    litMark: '#ffffff',
    labels: ['#0c181d', '#1c2b31', '#4a6066'],
  },
  dark: {
    faint: 'rgba(99, 204, 192, 0.18)',
    face: 'rgba(10, 17, 24, 0.94)',
    litMark: '#041215',
    labels: ['#ffffff', '#dceceb', '#9ab2b7'],
  },
};

type Props = {
  /** The node chosen as a filter; '' is all of them. */
  selected: string;
  /** The node whose examples are on screen, lit when nothing is hovered or chosen. */
  inView?: string;
  onSelect: (field: string) => void;
  /** Called with the hovered or focused node, '' when none. */
  onHover?: (node: string) => void;
  /** Reports runs on this machine, not on Roihu. */
  localReports?: boolean;
};

/** Canvas height in CSS pixels, as in the landing reference. */
const HEIGHT = 390;

/** One line glyph per field, drawn around the node centre. */
function glyph(ctx: CanvasRenderingContext2D, kind: string, r: number) {
  const s = r * 0.56;
  const dot = (x: number, y: number, rad: number) => {
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  };
  ctx.beginPath();
  if (kind === 'microbiome') {
    ctx.save();
    ctx.rotate(-0.55);
    ctx.ellipse(0, 0, s * 0.78, s * 0.42, 0, 0, Math.PI * 2);
    ctx.moveTo(s * 0.78, 0);
    ctx.bezierCurveTo(s * 1.05, -s * 0.28, s * 1.12, s * 0.28, s * 1.32, 0);
    ctx.stroke();
    dot(-s * 0.28, 0, s * 0.11);
    dot(s * 0.22, -s * 0.08, s * 0.1);
    ctx.restore();
  } else if (kind === 'transcriptomics') {
    ctx.moveTo(-s * 0.45, -s * 0.85);
    ctx.bezierCurveTo(-s * 0.45, -s * 0.15, s * 0.45, s * 0.15, s * 0.45, s * 0.85);
    ctx.moveTo(s * 0.45, -s * 0.85);
    ctx.bezierCurveTo(s * 0.45, -s * 0.15, -s * 0.45, s * 0.15, -s * 0.45, s * 0.85);
    ctx.moveTo(-s * 0.36, -s * 0.52);
    ctx.lineTo(s * 0.36, -s * 0.52);
    ctx.moveTo(-s * 0.36, s * 0.52);
    ctx.lineTo(s * 0.36, s * 0.52);
    ctx.stroke();
  } else if (kind === 'singlecell') {
    ctx.arc(0, 0, s * 0.82, 0, Math.PI * 2);
    ctx.moveTo(s * 0.26, -s * 0.05);
    ctx.arc(-s * 0.1, -s * 0.05, s * 0.36, 0, Math.PI * 2);
    ctx.stroke();
    dot(s * 0.38, s * 0.32, s * 0.11);
  } else if (kind === 'spatial') {
    const spots = [
      [-0.5, -0.45],
      [0, -0.45],
      [0.5, -0.45],
      [-0.25, 0],
      [0.25, 0],
      [-0.5, 0.45],
      [0, 0.45],
      [0.5, 0.45],
    ];
    spots.forEach(([x, y], i) =>
      dot(x * s * 1.1, y * s * 1.1, s * (i === 3 || i === 4 ? 0.17 : 0.13)),
    );
  } else if (kind === 'proteomics') {
    ctx.moveTo(-s * 0.85, s * 0.55);
    ctx.lineTo(s * 0.85, s * 0.55);
    [
      [-0.55, 0.2],
      [-0.22, -0.65],
      [0.12, -0.25],
      [0.42, -0.82],
      [0.68, 0.05],
    ].forEach(([x, y]) => {
      ctx.moveTo(x * s, s * 0.55);
      ctx.lineTo(x * s, y * s);
    });
    ctx.stroke();
  } else if (kind === 'metabolomics') {
    /* A chromatogram: baseline with two peaks. */
    ctx.moveTo(-s * 0.9, s * 0.55);
    ctx.bezierCurveTo(-s * 0.5, s * 0.55, -s * 0.45, -s * 0.75, -s * 0.2, -s * 0.75);
    ctx.bezierCurveTo(0, -s * 0.75, 0, s * 0.55, s * 0.2, s * 0.55);
    ctx.bezierCurveTo(s * 0.4, s * 0.55, s * 0.45, -s * 0.2, s * 0.6, -s * 0.2);
    ctx.bezierCurveTo(s * 0.75, -s * 0.2, s * 0.75, s * 0.55, s * 0.9, s * 0.55);
    ctx.stroke();
  } else if (kind === 'multiomics') {
    [-0.45, 0.05, 0.55].forEach((dy) => {
      ctx.moveTo(0, (dy - 0.3) * s);
      ctx.lineTo(s * 0.85, dy * s);
      ctx.lineTo(0, (dy + 0.3) * s);
      ctx.lineTo(-s * 0.85, dy * s);
      ctx.closePath();
    });
    ctx.stroke();
  } else if (kind === 'functional') {
    /* Pathway / ontology graph */
    const pts = [
      [-0.55, 0],
      [0.35, -0.52],
      [0.35, 0.52],
    ];
    ctx.moveTo(pts[0][0] * s, pts[0][1] * s);
    ctx.lineTo(pts[1][0] * s, pts[1][1] * s);
    ctx.moveTo(pts[0][0] * s, pts[0][1] * s);
    ctx.lineTo(pts[2][0] * s, pts[2][1] * s);
    ctx.stroke();
    pts.forEach(([x, y]) => dot(x * s, y * s, s * 0.22));
  } else if (kind === 'genomes') {
    /* Circular genome with variant ticks */
    ctx.arc(0, 0, s * 0.68, 0, Math.PI * 2);
    [0, 1.3, 2.7, 4.4].forEach((a) => {
      ctx.moveTo(Math.cos(a) * s * 0.5, Math.sin(a) * s * 0.5);
      ctx.lineTo(Math.cos(a) * s * 0.92, Math.sin(a) * s * 0.92);
    });
    ctx.stroke();
  } else if (kind === 'reports') {
    /* Report page with lines */
    ctx.roundRect(-s * 0.65, -s * 0.8, s * 1.3, s * 1.6, s * 0.16);
    ctx.moveTo(-s * 0.35, -s * 0.35);
    ctx.lineTo(s * 0.35, -s * 0.35);
    ctx.moveTo(-s * 0.35, 0.05 * s);
    ctx.lineTo(s * 0.35, 0.05 * s);
    ctx.moveTo(-s * 0.35, 0.45 * s);
    ctx.lineTo(s * 0.1, 0.45 * s);
    ctx.stroke();
  } else {
    ctx.arc(0, 0, s * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * OmicsBase: the fields as a living network around OmicsBase, after the landing
 * reference. The drawing is a canvas; every node also has a real, invisible
 * button on top, so the network works with a keyboard and a screen reader, and
 * choosing a node filters the examples.
 */
export default function FieldNetwork({
  selected,
  inView = '',
  onSelect,
  onHover,
  localReports = false,
}: Props) {
  const localize = useLocalize();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHoveredState] = useState('');
  const setHovered = (id: string) => {
    setHoveredState(id);
    onHover?.(id);
  };
  const state = useRef({ selected, inView, hovered });
  state.current = { selected, inView, hovered };
  const redraw = useRef<() => void>(() => undefined);
  const labelsRef = useRef<Record<string, string>>({});
  labelsRef.current = Object.fromEntries(
    NODES.map((n) => [n.id, localize(nodeShort(n, localReports))]),
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      return;
    }
    const root = document.documentElement;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    /* The reference's PNG marks; the app's logo.svg wraps a PNG and does not draw on a canvas. */
    const logoLight = new Image();
    logoLight.src = 'assets/logo-light.png';
    const logoDark = new Image();
    logoDark.src = 'assets/logo-dark.png';
    let w = 0;
    let frame = 0;

    const draw = (time: number) => {
      const light = !root.classList.contains('dark');
      const current = state.current;
      const labels = labelsRef.current;
      const colour = (n: FieldNode) => (light ? n.light : n.dark);
      const focus = current.hovered || current.selected || current.inView || HUB_NODE.id;
      const pts = NODES.map((n, i) => ({
        n,
        x: (n.x + (i === 0 ? 0 : Math.sin(time * 0.00055 + i) * 0.011)) * w,
        y: (n.y + (i === 0 ? 0 : Math.cos(time * 0.00065 + i) * 0.013)) * HEIGHT,
        r: n.r + 4,
      }));
      const byName = Object.fromEntries(pts.map((p) => [p.n.id, p]));
      const active = byName[focus] ?? byName[HUB_NODE.id];
      const ink = light ? INK.light : INK.dark;
      const faint = ink.faint;

      ctx.clearRect(0, 0, w, HEIGHT);
      const drawn = new Set<string>();
      pts.forEach((a) => {
        a.n.links.forEach((to, k) => {
          const b = byName[to];
          const key = [a.n.id, to].sort().join('|');
          if (!b || drawn.has(key)) {
            return;
          }
          drawn.add(key);
          const related = a.n.id === active.n.id || to === active.n.id;
          ctx.strokeStyle = related ? colour(active.n) : faint;
          ctx.globalAlpha = related ? 0.78 : 0.45;
          ctx.lineWidth = related ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          if (related) {
            const t = (time * 0.00065 + k * 0.27) % 1;
            ctx.globalAlpha = 0.96;
            ctx.fillStyle = colour(active.n);
            ctx.beginPath();
            ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 2.9, 0, Math.PI * 2);
            ctx.fill();
          }
        });
      });
      ctx.globalAlpha = 1;

      pts.forEach((p) => {
        const c = colour(p.n);
        const lit = p.n.id === active.n.id;
        const near = active.n.links.includes(p.n.id);
        const rad = lit ? p.r * 1.14 : p.r;
        if (lit) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, rad * 1.45, 0, Math.PI * 2);
          ctx.fillStyle = `${c}28`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = lit ? c : ink.face;
        ctx.fill();
        ctx.lineWidth = lit || near ? 2.2 : 1.4;
        ctx.strokeStyle = c;
        ctx.stroke();

        ctx.save();
        ctx.translate(p.x, p.y);
        const mark = lit ? ink.litMark : c;
        ctx.strokeStyle = mark;
        ctx.fillStyle = mark;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(1.4, rad * 0.105);
        const logo = light ? logoLight : logoDark;
        if (p.n.id === 'hub' && logo.complete && logo.naturalWidth > 0) {
          const size = rad * 1.15;
          ctx.drawImage(logo, -size / 2, -size / 2, size, size);
        } else {
          glyph(ctx, p.n.id, rad);
        }
        ctx.restore();

        let rank = 2;
        if (near) {
          rank = 1;
        }
        if (lit) {
          rank = 0;
        }
        ctx.fillStyle = ink.labels[rank];
        ctx.font = `${lit ? 600 : 500} 11.5px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(labels[p.n.id], p.x, p.y + rad + 14);
      });
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(still.matches ? 0 : performance.now());
    };
    const tick = (time: number) => {
      draw(time);
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      if (still.matches) {
        draw(0);
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    redraw.current = () => {
      if (still.matches) {
        draw(0);
      }
    };
    logoLight.onload = () => redraw.current();
    logoDark.onload = () => redraw.current();

    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(canvas);
    const themeObserver = new MutationObserver(() => redraw.current());
    themeObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
    still.addEventListener('change', start);
    resize();
    start();
    return () => {
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      themeObserver.disconnect();
      still.removeEventListener('change', start);
    };
  }, []);

  /* A still network must still show a new choice. */
  useEffect(() => {
    redraw.current();
  }, [selected, inView, hovered]);

  return (
    <div
      className="relative w-full"
      style={{ height: HEIGHT }}
      role="group"
      aria-label={localize('com_discover_filter_field')}
    >
      <canvas ref={canvasRef} className="block h-full w-full" aria-hidden="true" />
      {NODES.map((n) => {
        const value = n.id === HUB_NODE.id ? '' : n.id;
        const size = (n.r + 4) * 2 + 16;
        return (
          <button
            key={n.id}
            type="button"
            aria-label={value ? localize(n.label) : localize('com_discover_all')}
            aria-pressed={selected === value}
            onClick={() => onSelect(selected === value ? '' : value)}
            onMouseEnter={() => setHovered(n.id)}
            onMouseLeave={() => setHovered('')}
            onFocus={() => setHovered(n.id)}
            onBlur={() => setHovered('')}
            style={{ left: `${n.x * 100}%`, top: `${n.y * 100}%`, width: size, height: size }}
            className="focus-visible:ring-ring-primary absolute -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:ring-2 focus-visible:outline-none"
          />
        );
      })}
    </div>
  );
}
