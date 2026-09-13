import { useEffect, useRef, useState } from "react";
import { getReply, transcribeAudio } from "./api.js";
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, stage]);

  function updateMessage(id, changes) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)));
  }

  async function reply(text) {
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
      const data = await getReply(history);
      setMessages((prev) => [
        ...prev,
        {
          id: nextId++,
          role: "assistant",
          text: data.response,
          audioSrc: mp3Url(data.audio_base64),
        },
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
    await reply(transcript);
  }

  function submitText(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || isRecording) return;

    setError("");
    setDraft("");
    setMessages((prev) => [...prev, { id: nextId++, role: "user", text }]);
    reply(text);
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
            <div key={m.id} className={`bubble ${m.role}`}>
              <span className="role">{m.role === "user" ? "You" : "Agent"}</span>
              {m.pending ? <Dots /> : <p>{m.text}</p>}
              {m.audioSrc && (
                <audio controls src={m.audioSrc} autoPlay />
              )}
            </div>
          ))}

          {stage === "thinking" && (
            <div className="bubble assistant">
              <span className="role">Agent</span>
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
