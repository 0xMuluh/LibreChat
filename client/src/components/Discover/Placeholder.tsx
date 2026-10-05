/** A small drawn chart for an example that has no cover plot yet, varied by its id. */
export default function Placeholder({ seed }: { seed: string }) {
  let state = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const bars = Array.from({ length: 9 }, () => 0.25 + random() * 0.7);
  return (
    <svg viewBox="0 0 160 90" className="size-full" aria-hidden="true">
      <line x1="14" y1="78" x2="150" y2="78" className="stroke-border-medium" strokeWidth="1" />
      <line x1="14" y1="10" x2="14" y2="78" className="stroke-border-medium" strokeWidth="1" />
      {bars.map((h, i) => (
        <rect
          key={i}
          x={20 + i * 14.5}
          y={78 - h * 62}
          width="10"
          height={h * 62}
          rx="1.5"
          className="fill-accent-primary"
          opacity={0.35 + (i % 3) * 0.2}
        />
      ))}
    </svg>
  );
}
