import { useEffect, useRef, useState } from "react";
import { getReply, transcribeAudio } from "./api.js";
import { useRecorder } from "./useRecorder.js";

let nextId = 1;

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
  const [autoPlay, setAutoPlay] = useState(true);
  const { isRecording, start, stop } = useRecorder();
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, stage]);

  function updateMessage(id, changes) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)));
  }

  async function submit(blob, filename) {
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
    setStage("thinking");

    try {
      const data = await getReply(transcript);
      setMessages((prev) => [
        ...prev,
        {
          id: nextId++,
          role: "assistant",
          text: data.response,
          audioSrc: `data:audio/mpeg;base64,${data.audio_base64}`,
          autoPlay,
        },
      ]);
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setStage(null);
    }
  }

  async function handleMicClick() {
    if (isRecording) {
      const result = await stop();
      if (result && result.blob.size > 0) submit(result.blob, result.filename);
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

  return (
    <div className="app">
      <header className="header">
        <h1>Voice Agent</h1>
        <label className="toggle">
          <input
            type="checkbox"
            checked={autoPlay}
            onChange={(e) => setAutoPlay(e.target.checked)}
          />
          Auto-play replies
        </label>
      </header>

      <main className="chat">
        {messages.length === 0 && !busy && (
          <p className="empty">
            Tap the microphone and start speaking.
          </p>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            <span className="role">{m.role === "user" ? "You" : "Agent"}</span>
            {m.pending ? <Dots /> : <p>{m.text}</p>}
            {m.audioSrc && (
              <audio controls src={m.audioSrc} autoPlay={m.autoPlay} />
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
      </main>

      {error && <div className="error">{error}</div>}

      <footer className="controls">
        <button
          type="button"
          className={`mic ${isRecording ? "recording" : ""}`}
          onClick={handleMicClick}
          disabled={busy}
          aria-label={isRecording ? "Stop recording" : "Start recording"}
        >
          {isRecording ? (
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
              />
            </svg>
          )}
        </button>

        <span className="status">
          {isRecording ? "Listening… tap to send" : STATUS[stage] ?? "Ready"}
        </span>
      </footer>
    </div>
  );
}
