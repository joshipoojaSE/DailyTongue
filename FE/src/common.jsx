// Pieces shared by Free Talk and scene practice.
import { useEffect, useRef, useState } from "react";
import { speak } from "./api.js";
import Tongue from "./Tongue.jsx";

// The server stores UTC times as "YYYY-MM-DD HH:MM:SS".
export function parseServerTime(value) {
  return new Date(`${value.replace(" ", "T")}Z`);
}

// Blob URLs play and replay reliably; long data: URLs often can't be
// seeked or replayed in Chrome once they've finished.
export function mp3Url(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}

export function Dots() {
  return (
    <p className="dots">
      <span />
      <span />
      <span />
    </p>
  );
}

export function MicIcon({ size }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
      />
    </svg>
  );
}

export function KeyboardIcon({ size, className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14.5h8"
      />
    </svg>
  );
}

// Only one tutor sentence plays at a time.
let activeAudio = null;

// Reads a tutor sentence aloud. The audio is fetched on the first click and
// reused after that, so each sentence costs at most one speech request.
// `onPlayingChange(text, playing)` reports when it starts and stops.
export function SpeakButton({ text, onPlayingChange }) {
  // "idle" | "loading" | "playing" | "error"
  const [state, setState] = useState("idle");
  const audioRef = useRef(null);

  useEffect(() => () => audioRef.current?.pause(), []);

  async function toggle() {
    let audio = audioRef.current;
    if (state === "playing") {
      audio.pause();
      return;
    }

    try {
      if (!audio) {
        setState("loading");
        const { audio_base64 } = await speak(text);
        audio = new Audio(mp3Url(audio_base64));
        audio.onplay = () => {
          setState("playing");
          onPlayingChange?.(text, true);
        };
        audio.onpause = audio.onended = () => {
          setState("idle");
          onPlayingChange?.(text, false);
        };
        audioRef.current = audio;
      }
      if (activeAudio && activeAudio !== audio) activeAudio.pause();
      activeAudio = audio;
      audio.currentTime = 0;
      await audio.play();
    } catch {
      setState("error");
    }
  }

  const label = {
    idle: "Listen",
    loading: "Loading audio",
    playing: "Stop",
    error: "Couldn't play audio. Try again",
  }[state];

  return (
    <button
      type="button"
      className={`speak ${state}`}
      onClick={toggle}
      disabled={state === "loading"}
      aria-label={`${label}: ${text}`}
      title={label}
    >
      {state === "playing" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
          <path
            d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}

// Ila the tutor's note on one of the user's messages:
// { status: "pending" | "done" | "error", data? }.
export function Feedback({ feedback }) {
  const { status, data } = feedback;
  const correct = status === "done" && data.mistakes.length === 0;
  // The sentence Ila is reading aloud, if any.
  const [speaking, setSpeaking] = useState(null);

  function speakingChange(text, playing) {
    setSpeaking((prev) => (playing ? text : prev === text ? null : prev));
  }

  const mood = speaking
    ? "talking"
    : { pending: "thinking", error: "oops" }[status] ?? (correct ? "happy" : "rest");

  let body;
  if (status === "pending") {
    body = <Dots />;
  } else if (status === "error") {
    body = <p>Couldn't check this message.</p>;
  } else if (correct) {
    body = <p>Perfect English. Nicely said!</p>;
  } else {
    body = (
      <>
        <p>
          Try saying: <strong>{data.corrected}</strong>
          <SpeakButton text={data.corrected} onPlayingChange={speakingChange} />
        </p>
        <ul className="mistakes">
          {data.mistakes.map((m, i) => (
            <li key={i}>
              <s>{m.original}</s> → <strong>{m.correction}</strong>
              <span className="why">{m.explanation}</span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <div className={`feedback ${correct ? "correct" : ""}`}>
      <span className="role">
        <Tongue size={22} mood={mood} glasses />
        Ila · Tutor
      </span>
      {body}
      {status === "done" && data.rephrased && (
        <p className="rephrased">
          Another way to say it: <em>{data.rephrased}</em>
          <SpeakButton text={data.rephrased} onPlayingChange={speakingChange} />
        </p>
      )}
    </div>
  );
}

// "← Back to chat" at the top of a full-page view.
export function BackButton({ onClick, children }) {
  return (
    <button type="button" className="back" onClick={onClick}>
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
      {children}
    </button>
  );
}
