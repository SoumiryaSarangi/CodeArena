/**
 * The architecture of SD-§3.2 as a plain SVG: what talks to what. Text is real text (readable by a
 * screen reader), colours are tokens, no decoration.
 */
const Box = ({
  x,
  y,
  w = 120,
  h = 44,
  title,
  sub,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  title: string;
  sub: string;
}) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={6} className="fill-surface-2 stroke-border-strong" />
    <text x={x + w / 2} y={y + 19} textAnchor="middle" className="fill-text text-12 font-medium">
      {title}
    </text>
    <text x={x + w / 2} y={y + 34} textAnchor="middle" className="fill-text-2 text-12">
      {sub}
    </text>
  </g>
);

const Arrow = ({
  d,
  label,
  lx,
  ly,
  anchor = 'middle',
}: {
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
  anchor?: 'start' | 'middle';
}) => (
  <g>
    <path d={d} fill="none" className="stroke-text-3" strokeWidth={1.25} markerEnd="url(#arrow)" />
    {label ? (
      <text x={lx} y={ly} textAnchor={anchor} className="fill-text-3 text-12">
        {label}
      </text>
    ) : null}
  </g>
);

export function Architecture() {
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label="Architecture diagram, scrolls sideways on a narrow screen"
      className="max-w-3xl relative overflow-x-auto"
    >
      <svg
        viewBox="0 0 760 330"
        role="img"
        aria-label="Architecture: the browser reaches the web app on Vercel and, through Caddy, the API on the API server. The API uses Postgres, Redis and object storage. Judge workers in a private network read jobs from Redis, run them in a sandbox, and send results back through Redis."
        className="h-auto w-full min-w-[48rem] text-text"
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" className="fill-text-3" />
          </marker>
        </defs>
        <rect
          x={250}
          y={10}
          width={500}
          height={310}
          rx={8}
          className="fill-none stroke-border-strong"
          strokeDasharray="4 4"
        />
        <text x={262} y={28} className="fill-text-3 text-12">
          API server (Azure)
        </text>

        <Box x={10} y={40} title="Browser" sub="you" />
        <Box x={10} y={140} title="Web app" sub="Next.js on Vercel" />
        <Box x={290} y={140} title="Caddy" sub="TLS, routing" />
        <Box x={460} y={140} title="API" sub="NestJS" />
        <Box x={620} y={50} w={120} title="Postgres" sub="source of truth" />
        <Box x={620} y={140} w={120} title="Redis" sub="queues, events" />
        <Box x={620} y={230} w={120} title="Object storage" sub="tests, packages" />
        <Box x={290} y={240} w={140} title="Collector" sub="traces, metrics" />

        <rect
          x={10}
          y={240}
          width={225}
          height={74}
          rx={8}
          className="fill-none stroke-border-strong"
          strokeDasharray="4 4"
        />
        <text x={20} y={257} className="fill-text-3 text-12">
          Judge network (private, no internet)
        </text>
        <Box x={25} y={266} w={160} h={40} title="Judge workers" sub="Go + isolate sandbox" />

        <Arrow d="M70,84 L70,140" />
        <Arrow d="M130,162 L290,162" label="/api" lx={210} ly={154} />
        <Arrow d="M410,162 L460,162" />
        <Arrow d="M580,155 L620,85" />
        <Arrow d="M580,162 L620,162" />
        <Arrow d="M580,170 L620,245" />
        <Arrow
          d="M105,266 L105,230 L640,230 L640,184"
          label="jobs and results over Redis (own user, no database)"
          lx={262}
          ly={222}
          anchor="start"
        />
        <Arrow d="M185,290 L290,262" label="telemetry" lx={236} ly={284} />
      </svg>
    </div>
  );
}
