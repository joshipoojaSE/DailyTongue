import { Fragment, useEffect, useRef, useState } from "react";
import { getFeedback, getReply, speak, transcribeAudio } from "./api.js";
import { SILENCE_MS, useRecorder } from "./useRecorder.js";

let nextId = 1;

// Blob URLs play and replay reliably; long data: URLs often can't be
// seeked or replayed in Chrome once they've finished.
function mp3Url(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}

const STATUS = {
  transcribing: "Transcribing…",
  thinking: "Thinking…",
};

function Dots() {
  return (
    <p className="dots">
      <span />
      <span />
      <span />
    </p>
  );
}

// Only one tutor sentence plays at a time.
let activeAudio = null;

// Reads a tutor sentence aloud. The audio is fetched on the first click and
// reused after that, so each sentence costs at most one speech request.
function SpeakButton({ text }) {
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
        audio.onplay = () => setState("playing");
        audio.onpause = audio.onended = () => setState("idle");
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
function Feedback({ feedback }) {
  const { status, data } = feedback;
  const correct = status === "done" && data.mistakes.length === 0;

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
          <SpeakButton text={data.corrected} />
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
      <span className="role">Ila · Tutor</span>
      {body}
      {status === "done" && data.rephrased && (
        <p className="rephrased">
          Another way to say it: <em>{data.rephrased}</em>
          <SpeakButton text={data.rephrased} />
        </p>
      )}
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState([]);
  // null | "transcribing" | "thinking"
  const [stage, setStage] = useState(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const { isRecording, levels, start, stop, cancel } = useRecorder({
    onSilence: finishRecording,
  });
  const bottomRef = useRef(null);
  // Assigned by the server on the first reply; groups the tutor's feedback.
  const conversationIdRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, stage]);

  function updateMessage(id, changes) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)));
  }

  // The tutor checks the user's message once Kai has replied, so it sees both
  // sides of the conversation; its note appears under that message.
  async function checkEnglish(userId, conversationId, conversation) {
    updateMessage(userId, { feedback: { status: "pending" } });
    try {
      const data = await getFeedback(conversationId, conversation);
      updateMessage(userId, { feedback: { status: "done", data } });
    } catch {
      updateMessage(userId, { feedback: { status: "error" } });
    }
  }

  async function reply(userId, text) {
    setStage("thinking");

    // Earlier turns plus the new user message. `messages` is this render's
    // snapshot, taken before the new message was added to state.
    const history = [
      ...messages
        .filter((m) => !m.pending && m.text)
        .map((m) => ({ role: m.role, content: m.text })),
      { role: "user", content: text },
    ];

    try {
      const data = await getReply(history, conversationIdRef.current);
      conversationIdRef.current = data.conversation_id;
      setMessages((prev) => [
        ...prev,
        {
          id: nextId++,
          role: "assistant",
          text: data.response,
          audioSrc: mp3Url(data.audio_base64),
        },
      ]);
      checkEnglish(userId, data.conversation_id, [
        ...history,
        { role: "assistant", content: data.response },
      ]);
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setStage(null);
    }
  }

  async function submitAudio(blob, filename) {
    setError("");

    // Show the user's bubble immediately; fill in the text once transcribed.
    const userId = nextId++;
    setMessages((prev) => [...prev, { id: userId, role: "user", pending: true }]);
    setStage("transcribing");

    let transcript;
    try {
      ({ transcript } = await transcribeAudio(blob, filename));
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== userId));
      setError(err.message || "Something went wrong");
      setStage(null);
      return;
    }

    if (!transcript.trim()) {
      setMessages((prev) => prev.filter((m) => m.id !== userId));
      setError("Sorry, I didn't catch that. Please try again.");
      setStage(null);
      return;
    }

    updateMessage(userId, { text: transcript, pending: false });
    await reply(userId, transcript);
  }

  function submitText(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || isRecording) return;

    setError("");
    setDraft("");
    const userId = nextId++;
    setMessages((prev) => [...prev, { id: userId, role: "user", text }]);
    reply(userId, text);
  }

  async function finishRecording() {
    const result = await stop();
    if (result && result.blob.size > 0) submitAudio(result.blob, result.filename);
  }

  async function handleMicClick() {
    if (isRecording) {
      finishRecording();
      return;
    }
    try {
      setError("");
      await start();
    } catch {
      setError("Microphone access was denied or is unavailable.");
    }
  }

  const busy = stage !== null;
  const placeholder = STATUS[stage] ?? "Type in English, or tap the mic to talk";

  return (
    <div className="app">
      <header className="header">
        <div className="container header-inner">
          <h1 className="logo">
            Daily<span>Tongue</span>
          </h1>
        </div>
      </header>

      <main className="chat">
        <div className="container chat-inner">
          {messages.length === 0 && !busy && (
            <p className="empty">
              Say hello in English — type below or tap the mic.
            </p>
          )}

          {messages.map((m) => (
            <Fragment key={m.id}>
              <div className={`bubble ${m.role}`}>
                <span className="role">{m.role === "user" ? "You" : "Kai"}</span>
                {m.pending ? <Dots /> : <p>{m.text}</p>}
                {m.audioSrc && (
                  <audio controls src={m.audioSrc} autoPlay />
                )}
              </div>
              {m.feedback && <Feedback feedback={m.feedback} />}
            </Fragment>
          ))}

          {stage === "thinking" && (
            <div className="bubble assistant">
              <span className="role">Kai</span>
              <Dots />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <footer className="container controls">
        {error && <div className="error">{error}</div>}

        <form className={`composer ${isRecording ? "recording" : ""}`} onSubmit={submitText}>
          {isRecording ? (
            <>
              <div className="listening" role="status">
                <div className="waveform" aria-hidden="true">
                  {levels.map((level, i) => (
                    <span key={i} style={{ height: 8 + level * 22 }} />
                  ))}
                </div>
                <p className="listening-hint">
                  Listening… I'll stop after {SILENCE_MS / 1000} seconds of quiet
                </p>
              </div>

              <button
                type="button"
                className="cancel"
                onClick={cancel}
                aria-label="Cancel recording"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    d="M7 7l10 10M17 7 7 17"
                  />
                </svg>
              </button>
            </>
          ) : (
            <>
              <svg className="keyboard" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <rect x="2.5" y="6" width="19" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14.5h8"
                />
              </svg>

              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={placeholder}
                aria-label="Message"
              />

              <button
                type="submit"
                className="send"
                disabled={!draft.trim() || busy}
                aria-label="Send message"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 12h14M13 6l6 6-6 6"
                  />
                </svg>
              </button>
            </>
          )}

          <button
            type="button"
            className={`mic ${isRecording ? "recording" : ""}`}
            onClick={handleMicClick}
            disabled={busy}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
          >
            {isRecording ? (
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
                />
              </svg>
            )}
          </button>
        </form>
      </footer>
    </div>
  );
}
