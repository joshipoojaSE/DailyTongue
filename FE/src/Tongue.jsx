// DailyTongue's mascot: a little tongue whose face and motion follow what's
// happening in the app. Styles and animations live in index.css (.tongue).
//
// mood: "rest" (still) | "idle" | "happy" | "thinking" | "listening" | "talking" | "oops"
// level: 0–1 microphone level, opens the mouth while listening.
// glasses: worn by Ila, the tutor.

const BODY =
  "M12 14C12 8 18 6 24 7c4 .6 6 2 8 2s4-1.4 8-2c6-1 12 1 12 7v22c0 14-9 22-20 22S12 50 12 36Z";

function Eyes({ mood }) {
  if (mood === "happy") {
    return <path className="tongue-line" d="M20 29q4-5 8 0M36 29q4-5 8 0" />;
  }
  if (mood === "oops") {
    return <path className="tongue-line" d="M21 25l5 3.2-5 3.2M43 25l-5 3.2 5 3.2" />;
  }

  // Thinking looks up and to the side.
  const look = mood === "thinking" ? "translate(1.5 -2)" : undefined;
  return (
    <g className="tongue-eyes">
      {[24, 40].map((x) => (
        <g key={x} transform={look}>
          <circle className="tongue-ink" cx={x} cy="28" r="4" />
          <circle className="tongue-sparkle" cx={x + 1.3} cy="26.6" r="1.3" />
        </g>
      ))}
    </g>
  );
}

function Mouth({ mood, level }) {
  switch (mood) {
    case "happy":
      return <path className="tongue-mouth" d="M25.5 37h13q-1 8-6.5 8t-6.5-8Z" />;
    case "thinking":
      return <circle className="tongue-mouth" cx="35" cy="40" r="2" />;
    case "listening":
      return <ellipse className="tongue-mouth" cx="32" cy="40" rx="3.2" ry={1.8 + level * 3.5} />;
    case "talking":
      return <ellipse className="tongue-mouth tongue-talk" cx="32" cy="40" rx="3.6" ry="3.2" />;
    case "oops":
      return <path className="tongue-line" d="M25 41q3.5-3 7 0t7 0" />;
    default:
      return <path className="tongue-line" d="M27 38q5 5 10 0" />;
  }
}

export default function Tongue({ mood = "idle", size = 40, level = 0, glasses = false }) {
  return (
    <svg
      className={`tongue tongue--${mood}`}
      viewBox="8 4 48 58"
      width={(size * 48) / 58}
      height={size}
      aria-hidden="true"
    >
      <g className="tongue-body">
        <path className="tongue-ledge" d={BODY} transform="translate(0 3)" />
        <path className="tongue-fill" d={BODY} />
        <path className="tongue-groove" d="M32 12v8" />
        <ellipse className="tongue-shine" cx="19.5" cy="15" rx="3.6" ry="2.2" transform="rotate(-25 19.5 15)" />
        <ellipse className="tongue-blush" cx="18.5" cy="36" rx="3.4" ry="2.2" />
        <ellipse className="tongue-blush" cx="45.5" cy="36" rx="3.4" ry="2.2" />
        <Eyes mood={mood} />
        {glasses && (
          <g className="tongue-glasses">
            <circle cx="24" cy="28" r="6.5" />
            <circle cx="40" cy="28" r="6.5" />
            <path d="M30.5 28h3" />
          </g>
        )}
        <Mouth mood={mood} level={level} />
      </g>
    </svg>
  );
}
