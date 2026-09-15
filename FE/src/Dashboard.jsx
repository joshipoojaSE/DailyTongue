// The practice dashboard: how long the learner talked with Kai on each day.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getProgress } from "./api.js";
import Tongue from "./Tongue.jsx";

// The date ranges on offer, in days ending today.
const RANGES = [7, 30, 90];

// "42 min", "1h", "1h 9m".
function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// Days arrive as IST calendar dates ("2026-09-15"). Formatting them at UTC midnight
// keeps that calendar date whatever the browser's time zone.
const toDate = (day) => new Date(`${day}T00:00:00Z`);
const utc = (options) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options });
const longDay = utc({ weekday: "short", day: "numeric", month: "short" });
const shortDay = utc({ day: "numeric", month: "short" });
const weekday = utc({ weekday: "short" });

// "Today", "Yesterday" or "Mon 14 Sept" for days[index], where the last day is today.
function dayName(days, index) {
  const fromEnd = days.length - 1 - index;
  if (fromEnd === 0) return "Today";
  if (fromEnd === 1) return "Yesterday";
  return longDay.format(toDate(days[index].date));
}

const PLOT_HEIGHT = 200;
const AXIS_BAND = 30;
const MARGIN = { top: 22, right: 8, left: 44 };
const MAX_BAR_WIDTH = 24;

// Evenly spaced y-axis ticks in minutes, from 0 to at least `max`, at most five of them.
function ticksFor(max) {
  const step = [15, 30, 60, 120, 180, 240, 360, 480, 720].find((s) => max / s <= 4) ?? 1440;
  const count = Math.max(1, Math.ceil(max / step));
  return { step, ticks: Array.from({ length: count + 1 }, (_, i) => i * step) };
}

// A column rounded at the top and square at the baseline.
function barPath(x, top, width, bottom) {
  const r = Math.min(4, width / 2, bottom - top);
  return (
    `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}` +
    `H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${bottom}Z`
  );
}

// Minutes per day as columns, pink on days that met the goal and muted on the rest, with
// the goal as a reference line. Hover a day, or focus the chart and use the arrow keys,
// to read its time.
function DailyChart({ days, goal }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(0);
  // Index of the day shown in the tooltip, if any.
  const [active, setActive] = useState(null);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    setWidth(wrap.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const n = days.length;
  const { step, ticks } = ticksFor(Math.max(goal, ...days.map((d) => d.minutes)));
  const top = ticks[ticks.length - 1];
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const band = plotWidth / n;
  // A 2px gap between days, narrowed when days are packed so tightly the bars would vanish.
  const barWidth = Math.max(1, Math.min(MAX_BAR_WIDTH, band - Math.min(2, band / 4)));
  const y = (minutes) => MARGIN.top + PLOT_HEIGHT * (1 - minutes / top);
  const baseline = y(0);
  const center = (i) => MARGIN.left + (i + 0.5) * band;
  // Label about one day per 64px, counting back from today so today is always labelled.
  const labelEvery = Math.ceil(n / Math.max(1, Math.floor(plotWidth / 64)));
  const tickLabel = (t) => (t === 0 ? "0" : step % 60 === 0 ? `${t / 60}h` : `${t} min`);

  function handleKeyDown(e) {
    const move = { ArrowLeft: -1, ArrowRight: 1, Home: -n, End: n }[e.key];
    if (!move) return;
    e.preventDefault();
    setActive((i) => Math.min(n - 1, Math.max(0, (i ?? n - 1) + move)));
  }

  const activeDay = active === null ? null : days[active];

  return (
    <div
      className="chart"
      ref={wrapRef}
      tabIndex={0}
      aria-label="Minutes practised per day. Use the left and right arrow keys to read each day."
      onKeyDown={handleKeyDown}
      onFocus={() => setActive((i) => i ?? n - 1)}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
    >
      {width > 0 && (
        <svg width={width} height={MARGIN.top + PLOT_HEIGHT + AXIS_BAND} aria-hidden="true">
          {ticks.map((t) => (
            <g key={t}>
              <line
                className="chart-grid"
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={Math.round(y(t)) + 0.5}
                y2={Math.round(y(t)) + 0.5}
              />
              <text className="chart-tick" x={MARGIN.left - 10} y={y(t)} dy="0.35em" textAnchor="end">
                {tickLabel(t)}
              </text>
            </g>
          ))}

          {days.map(
            (d, i) =>
              d.minutes > 0 && (
                <path
                  key={d.date}
                  className={`chart-bar ${d.minutes >= goal ? "met" : ""} ${i === active ? "active" : ""}`}
                  d={barPath(center(i) - barWidth / 2, y(d.minutes), barWidth, baseline)}
                />
              )
          )}

          <line
            className="chart-goal"
            x1={MARGIN.left}
            x2={width - MARGIN.right}
            y1={Math.round(y(goal)) + 0.5}
            y2={Math.round(y(goal)) + 0.5}
          />
          <text className="chart-goal-label" x={width - MARGIN.right} y={y(goal) - 7} textAnchor="end">
            Goal · {goal} min
          </text>

          {days.map((d, i) => {
            if ((n - 1 - i) % labelEvery !== 0) return null;
            // The last label would run off the edge when days are narrow, so it ends there instead.
            const atEdge = i === n - 1 && band < 56;
            return (
              <text
                key={d.date}
                className={`chart-tick ${i === active ? "active" : ""}`}
                x={atEdge ? width - MARGIN.right : center(i)}
                y={baseline + 20}
                textAnchor={atEdge ? "end" : "middle"}
              >
                {(n <= 7 ? weekday : shortDay).format(toDate(d.date))}
              </text>
            );
          })}

          {days.map((d, i) => (
            <rect
              key={d.date}
              fill="transparent"
              x={MARGIN.left + i * band}
              y={MARGIN.top}
              width={band}
              height={PLOT_HEIGHT}
              onPointerEnter={() => setActive(i)}
            />
          ))}
        </svg>
      )}

      {activeDay && (
        <div
          className="chart-tip"
          style={{
            left: Math.min(Math.max(center(active), 64), width - 64),
            top: y(activeDay.minutes),
          }}
        >
          <strong>{activeDay.minutes ? formatDuration(activeDay.minutes) : "No practice"}</strong>
          <span>{dayName(days, active)}</span>
          {activeDay.minutes > 0 && (
            <span>
              {activeDay.minutes >= goal ? "Goal met" : `${goal - activeDay.minutes} min short of goal`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, detail }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-detail">{detail}</span>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 12.5l4.5 4.5L19 7.5"
      />
    </svg>
  );
}

function Report({ progress }) {
  const { days, goal_minutes: goal } = progress;
  const n = days.length;
  const total = days.reduce((sum, d) => sum + d.minutes, 0);
  const goalDays = days.filter((d) => d.minutes >= goal).length;
  const best = days.reduce((a, b) => (b.minutes > a.minutes ? b : a));

  return (
    <>
      <div className="stats">
        <Stat label="Total practice" value={formatDuration(total)} detail={`in the last ${n} days`} />
        <Stat label="Daily average" value={formatDuration(Math.round(total / n))} detail="per day" />
        <Stat
          label="Goal met"
          value={`${goalDays} ${goalDays === 1 ? "day" : "days"}`}
          detail={`of ${n}, at ${goal} min a day`}
        />
        <Stat
          label="Best day"
          value={best.minutes ? formatDuration(best.minutes) : "—"}
          detail={best.minutes ? longDay.format(toDate(best.date)) : "No practice yet"}
        />
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Minutes per day</h3>
          <ul className="legend">
            <li>
              <span className="legend-swatch met" />
              Goal met
            </li>
            <li>
              <span className="legend-swatch" />
              Below goal
            </li>
          </ul>
        </div>
        <DailyChart days={days} goal={goal} />
      </section>

      <section className="card">
        <h3>Day by day</h3>
        <ul className="day-list">
          {days
            .map((d, i) => (
              <li key={d.date} className={d.minutes ? "" : "none"}>
                <span className="day-list-name">{dayName(days, i)}</span>
                <span className="day-list-time">
                  {d.minutes ? formatDuration(d.minutes) : "No practice"}
                </span>
                <span className="day-list-goal">
                  {d.minutes >= goal && (
                    <>
                      <CheckIcon />
                      Goal met
                    </>
                  )}
                </span>
              </li>
            ))
            .reverse()}
        </ul>
      </section>
    </>
  );
}

export default function Dashboard({ conversationId, onBack }) {
  const [range, setRange] = useState(RANGES[0]);
  // "loading" | "done" | "error". The last report stays on screen while another loads.
  const [status, setStatus] = useState("loading");
  const [progress, setProgress] = useState(null);
  // Bumped to retry after an error.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!conversationId) return;
    let ignore = false;
    setStatus("loading");
    getProgress(conversationId, range)
      .then((data) => {
        if (ignore) return;
        setProgress(data);
        setStatus("done");
      })
      .catch(() => {
        if (!ignore) setStatus("error");
      });
    return () => {
      ignore = true;
    };
  }, [conversationId, range, attempt]);

  let body;
  if (!conversationId) {
    body = (
      <div className="empty">
        <Tongue size={96} mood="happy" />
        <p>Talk with Kai to start tracking your practice.</p>
      </div>
    );
  } else if (!progress) {
    body =
      status === "error" ? (
        <div className="empty">
          <Tongue size={96} mood="oops" />
          <p>Couldn't load your practice.</p>
          <button type="button" className="retry" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <div className="empty">
          <Tongue size={96} mood="thinking" />
          <p>Loading your practice…</p>
        </div>
      );
  } else {
    body = (
      <>
        {status === "error" && (
          <div className="error">
            <Tongue size={28} mood="oops" />
            Couldn't load the last {range} days.
            <button type="button" className="retry" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </button>
          </div>
        )}
        <div className={`report ${status === "loading" ? "refreshing" : ""}`}>
          <Report progress={progress} />
        </div>
      </>
    );
  }

  return (
    <main className="dashboard">
      <div className="container dashboard-inner">
        <button type="button" className="back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 12H5M11 6l-6 6 6 6"
            />
          </svg>
          Back to chat
        </button>

        <div className="dashboard-heading">
          <h2>Your practice</h2>
          {conversationId && (
            <div className="range" role="group" aria-label="Date range">
              {RANGES.map((days) => (
                <button
                  key={days}
                  type="button"
                  aria-pressed={range === days}
                  onClick={() => setRange(days)}
                >
                  {days} days
                </button>
              ))}
            </div>
          )}
        </div>

        {body}
      </div>
    </main>
  );
}
