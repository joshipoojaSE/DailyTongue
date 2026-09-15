import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  getFeedback,
  getMessages,
  getReply,
  getProgress,
  messageAudioUrl,
  speak,
  transcribeAudio,
} from "./api.js";
import Dashboard from "./Dashboard.jsx";
import Tongue from "./Tongue.jsx";
import { SILENCE_MS, useRecorder } from "./useRecorder.js";

let nextId = 1;

// The conversation is remembered in this browser, so its history comes back after a reload.
const CONVERSATION_KEY = "dailytongue.conversationId";

function loadConversationId() {
  try {
    return localStorage.getItem(CONVERSATION_KEY);
  } catch {
    return null;
  }
}

function saveConversationId(id) {
  try {
    localStorage.setItem(CONVERSATION_KEY, id);
  } catch {
    // Storage is unavailable; the chat still works, it just won't survive a reload.
  }
}

const savedConversationId = loadConversationId();

// Today's { minutes, goal_minutes } in the conversation.
async function getToday(conversationId) {
  const { goal_minutes, days } = await getProgress(conversationId, 1);
  return { minutes: days[days.length - 1].minutes, goal_minutes };
}

// Times are shown in India Standard Time, e.g. "19:40" and "Tue 8 Sept".
const IST = "Asia/Kolkata";
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

// { weekday, day, month, year } of a moment's date in IST.
function istDate(date) {
  return Object.fromEntries(dateFormat.formatToParts(date).map((p) => [p.type, p.value]));
}

function istDayKey(date) {
  const { year, month, day } = istDate(date);
  return `${year} ${month} ${day}`;
}

function dayLabel(date) {
  const now = new Date();
  const key = istDayKey(date);
  if (key === istDayKey(now)) return "Today";
  if (key === istDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))) return "Yesterday";

  const { weekday, day, month, year } = istDate(date);
  const label = `${weekday} ${day} ${month}`;
  return year === istDate(now).year ? label : `${label} ${year}`;
}

// The server stores UTC times as "YYYY-MM-DD HH:MM:SS".
function parseServerTime(value) {
  return new Date(`${value.replace(" ", "T")}Z`);
}

// A message loaded from the server's history, in the shape the chat renders.
function fromStored(m) {
  return {
    id: nextId++,
    serverId: m.id,
    role: m.role,
    text: m.content,
    input: m.input,
    createdAt: parseServerTime(m.created_at),
    audioSrc: m.has_audio ? messageAudioUrl(m.id) : null,
    fromHistory: true,
    feedback: m.feedback ? { status: "done", data: m.feedback } : undefined,
  };
}

// Blob URLs play and replay reliably; long data: URLs often can't be
// seeked or replayed in Chrome once they've finished.
function mp3Url(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}

const STATUS = {
  loading: "Loading your conversation…",
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

function MicIcon({ size }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"
      />
    </svg>
  );
}

function KeyboardIcon({ size, className }) {
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

// "You · spoken · 19:40" or "Kai · 19:41" above a message, in IST. Kai's
// messages show the tongue mascot in the given mood.
function MessageMeta({ role, input, createdAt, mood = "rest" }) {
  const isUser = role === "user";
  const label = [
    isUser ? "You" : "Kai",
    isUser && input,
    createdAt && timeFormat.format(createdAt),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      className="meta"
      title={createdAt && `${dateFormat.format(createdAt)}, ${timeFormat.format(createdAt)} IST`}
    >
      {!isUser && <Tongue size={22} mood={mood} />}
      {isUser && input === "spoken" && <MicIcon size={14} />}
      {isUser && input === "typed" && <KeyboardIcon size={15} />}
      {label}
    </span>
  );
}

// Only one tutor sentence plays at a time.
let activeAudio = null;

// Reads a tutor sentence aloud. The audio is fetched on the first click and
// reused after that, so each sentence costs at most one speech request.
// `onPlayingChange(text, playing)` reports when it starts and stops.
function SpeakButton({ text, onPlayingChange }) {
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
function Feedback({ feedback }) {
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

const GOAL_RADIUS = 23;
const GOAL_CIRCUMFERENCE = 2 * Math.PI * GOAL_RADIUS;

// Today's minutes talking with Kai, as a ring that fills up towards the daily goal.
// Clicking it opens or closes the practice dashboard.
function DailyGoal({ minutes, goal, open, onClick }) {
  const met = minutes >= goal;
  const filled = Math.min(minutes / goal, 1);

  return (
    <button
      type="button"
      className={`goal ${met ? "met" : ""} ${open ? "open" : ""}`}
      onClick={onClick}
      aria-pressed={open}
      title={open ? "Back to chat" : "See your practice by day"}
    >
      <div className="goal-ring">
        <svg className="goal-progress" viewBox="0 0 56 56" aria-hidden="true">
          <circle className="goal-track" cx="28" cy="28" r={GOAL_RADIUS} />
          {/* A round cap would show a dot at zero, so the arc appears with the first minute. */}
          {filled > 0 && (
            <circle
              className="goal-fill"
              cx="28"
              cy="28"
              r={GOAL_RADIUS}
              strokeDasharray={GOAL_CIRCUMFERENCE}
              strokeDashoffset={GOAL_CIRCUMFERENCE * (1 - filled)}
              transform="rotate(-90 28 28)"
            />
          )}
        </svg>
        <span className="goal-face">
          <Tongue size={26} mood={met ? "happy" : "rest"} />
        </span>
      </div>
      <span className="goal-text">
        <span className="goal-title">
          <span>{minutes}</span> of {goal} min today
        </span>
        <span className="goal-hint">
          {met ? "Goal met! Anything more is a bonus" : `${goal - minutes} min to go`}
        </span>
      </span>
    </button>
  );
}

export default function App() {
  const [messages, setMessages] = useState([]);
  // { minutes, goal_minutes } talked today, once a conversation exists.
  const [progress, setProgress] = useState(null);
  // "chat" | "progress" (the practice dashboard).
  const [view, setView] = useState("chat");
  // null | "loading" | "transcribing" | "thinking"
  const [stage, setStage] = useState(savedConversationId ? "loading" : null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  // Whether the server has messages older than the ones shown.
  const [hasMore, setHasMore] = useState(false);
  // Loading earlier messages: "idle" | "loading" | "error"
  const [older, setOlder] = useState("idle");
  // The id of Kai's message whose audio is playing, if any.
  const [playingId, setPlayingId] = useState(null);
  const { isRecording, hasSpoken, levels, start, stop, cancel } = useRecorder({
    onSilence: finishRecording,
    onNoSpeech: stopListening,
  });
  const chatRef = useRef(null);
  const topRef = useRef(null);
  const bottomRef = useRef(null);
  // How to scroll after the next update: "smooth" to the bottom, "jump" straight
  // to the bottom, or a number, the distance from the bottom to hold while older
  // messages are added above.
  const scrollRef = useRef("smooth");
  // Assigned by the server on the first reply; groups the conversation's messages.
  const conversationIdRef = useRef(savedConversationId);

  const oldestId = messages.find((m) => m.serverId)?.serverId;

  useLayoutEffect(() => {
    const chat = chatRef.current;
    const scroll = scrollRef.current;
    scrollRef.current = "smooth";
    if (scroll === "jump") {
      chat.scrollTop = chat.scrollHeight;
    } else if (typeof scroll === "number") {
      chat.scrollTop = chat.scrollHeight - scroll;
    } else {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, stage, view]);

  // Show the latest messages of the remembered conversation.
  useEffect(() => {
    const conversationId = conversationIdRef.current;
    if (!conversationId) return;

    let ignore = false;
    getMessages(conversationId)
      .then((page) => {
        if (ignore) return;
        scrollRef.current = "jump";
        setMessages(page.messages.map(fromStored));
        setHasMore(page.has_more);
      })
      .catch(() => {
        if (!ignore) setError("Couldn't load your earlier messages.");
      })
      .finally(() => {
        if (!ignore) setStage(null);
      });
    getToday(conversationId)
      .then((data) => {
        if (!ignore) setProgress(data);
      })
      .catch(() => {
        // The goal is a nice-to-have; the chat works without it.
      });
    return () => {
      ignore = true;
    };
  }, []);

  // Load earlier messages as the top of the chat scrolls into view. The observer
  // is recreated after each page, so it keeps loading while the top stays visible.
  useEffect(() => {
    if (!hasMore || older !== "idle") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadOlder(oldestId);
      },
      { root: chatRef.current, rootMargin: "400px 0px 0px 0px" }
    );
    observer.observe(topRef.current);
    return () => observer.disconnect();
  }, [hasMore, older, oldestId]);

  async function loadOlder(before) {
    setOlder("loading");
    try {
      const page = await getMessages(conversationIdRef.current, before);
      const chat = chatRef.current;
      scrollRef.current = chat.scrollHeight - chat.scrollTop;
      setMessages((prev) => [...page.messages.map(fromStored), ...prev]);
      setHasMore(page.has_more);
      setOlder("idle");
    } catch {
      setOlder("error");
    }
  }

  async function refreshProgress(conversationId) {
    try {
      setProgress(await getToday(conversationId));
    } catch {
      // Keep showing the last known progress.
    }
  }

  function updateMessage(id, changes) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)));
  }

  // The tutor checks the user's message once Kai has replied, so it sees both
  // sides of the conversation; its note appears under that message.
  async function checkEnglish(userId, conversationId, conversation, messageId) {
    updateMessage(userId, { feedback: { status: "pending" } });
    try {
      const data = await getFeedback(conversationId, conversation, messageId);
      updateMessage(userId, { feedback: { status: "done", data } });
    } catch {
      updateMessage(userId, { feedback: { status: "error" } });
    }
  }

  async function reply(userId, text, input) {
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
      const data = await getReply(history, conversationIdRef.current, input);
      conversationIdRef.current = data.conversation_id;
      saveConversationId(data.conversation_id);
      setMessages((prev) => [
        ...prev,
        {
          id: nextId++,
          role: "assistant",
          text: data.response,
          audioSrc: mp3Url(data.audio_base64),
          createdAt: new Date(),
        },
      ]);
      refreshProgress(data.conversation_id);
      checkEnglish(
        userId,
        data.conversation_id,
        [...history, { role: "assistant", content: data.response }],
        data.user_message_id
      );
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
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", input: "spoken", createdAt: new Date(), pending: true },
    ]);
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
    await reply(userId, transcript, "spoken");
  }

  function submitText(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || isRecording) return;

    setError("");
    setDraft("");
    const userId = nextId++;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text, input: "typed", createdAt: new Date() },
    ]);
    reply(userId, text, "typed");
  }

  async function finishRecording() {
    const result = await stop();
    if (result && result.blob.size > 0) submitAudio(result.blob, result.filename);
  }

  // Nothing was said after tapping the mic, so there's nothing worth transcribing.
  function stopListening() {
    cancel();
    setError("I didn't hear anything, so I stopped listening. Tap the mic to try again.");
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
  const micLevel = levels[levels.length - 1];

  // The header mascot mirrors what the app is doing right now.
  const mood = isRecording
    ? "listening"
    : busy
      ? "thinking"
      : playingId
        ? "talking"
        : error
          ? "oops"
          : "idle";

  // The chat stays mounted while the dashboard is open, so it comes back as it was.
  function showView(next) {
    if (next === "progress" && isRecording) cancel();
    // A hidden chat loses its scroll position; return to the latest messages.
    if (next === "chat") scrollRef.current = "jump";
    setView(next);
  }

  function audioEvents(id) {
    const stopped = () => setPlayingId((prev) => (prev === id ? null : prev));
    return { onPlay: () => setPlayingId(id), onPause: stopped, onEnded: stopped };
  }

  return (
    <div className="app">
      <header className="header">
        <div className="container header-inner">
          <h1 className="logo">
            <Tongue size={46} mood={mood} level={micLevel} />
            <span className="logo-text">
              Daily<span>Tongue</span>
            </span>
          </h1>
          {progress && (
            <DailyGoal
              minutes={progress.minutes}
              goal={progress.goal_minutes}
              open={view === "progress"}
              onClick={() => showView(view === "chat" ? "progress" : "chat")}
            />
          )}
        </div>
      </header>

      <main className="chat" ref={chatRef} hidden={view !== "chat"}>
        <div className="container chat-inner">
          {(hasMore || older === "error") && (
            <div className="history" ref={topRef}>
              {older === "loading" && (
                <p>
                  <Tongue size={20} mood="thinking" />
                  Loading earlier messages…
                </p>
              )}
              {older === "error" && (
                <button type="button" onClick={() => setOlder("idle")}>
                  Couldn't load earlier messages. Try again
                </button>
              )}
            </div>
          )}

          {stage === "loading" && messages.length === 0 && (
            <div className="empty">
              <Tongue size={96} mood="thinking" />
              <p>{STATUS.loading}</p>
            </div>
          )}

          {messages.length === 0 && !busy && (
            <div className="empty">
              <Tongue size={96} mood={isRecording ? "listening" : "happy"} level={micLevel} />
              <p>Say hello in English — type below or tap the mic.</p>
            </div>
          )}

          {messages.map((m, i) => {
            const newDay =
              i === 0 || istDayKey(m.createdAt) !== istDayKey(messages[i - 1].createdAt);
            return (
              <Fragment key={m.id}>
                {newDay && <div className="day">{dayLabel(m.createdAt)}</div>}
                <div className={`message ${m.role}`}>
                  <MessageMeta
                    role={m.role}
                    input={m.input}
                    createdAt={m.createdAt}
                    mood={playingId === m.id ? "talking" : "rest"}
                  />
                  <div className={`bubble ${m.role}`}>
                    {m.pending ? <Dots /> : <p>{m.text}</p>}
                    {m.audioSrc &&
                      (m.fromHistory ? (
                        <audio controls preload="none" src={m.audioSrc} {...audioEvents(m.id)} />
                      ) : (
                        <audio controls src={m.audioSrc} autoPlay {...audioEvents(m.id)} />
                      ))}
                  </div>
                </div>
                {m.feedback && <Feedback feedback={m.feedback} />}
              </Fragment>
            );
          })}

          {stage === "thinking" && (
            <div className="message assistant">
              <MessageMeta role="assistant" mood="thinking" />
              <div className="bubble assistant">
                <Dots />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <footer className="container controls" hidden={view !== "chat"}>
        {error && (
          <div className="error">
            <Tongue size={28} mood="oops" />
            {error}
          </div>
        )}

        <form className={`composer ${isRecording ? "recording" : ""}`} onSubmit={submitText}>
          {isRecording ? (
            <>
              <div className="listening" role="status">
                <Tongue size={40} mood="listening" level={micLevel} />
                <div className="listening-body">
                  <div className="waveform" aria-hidden="true">
                    {levels.map((level, i) => (
                      <span key={i} style={{ height: 8 + level * 22 }} />
                    ))}
                  </div>
                  <p className="listening-hint">
                    {hasSpoken
                      ? `Listening… I'll stop after ${SILENCE_MS / 1000} seconds of quiet`
                      : "Listening… go ahead and speak"}
                  </p>
                </div>
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
              <KeyboardIcon className="keyboard" size={22} />

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
              <MicIcon size={26} />
            )}
          </button>
        </form>
      </footer>

      {view === "progress" && (
        <Dashboard conversationId={conversationIdRef.current} onBack={() => showView("chat")} />
      )}
    </div>
  );
}
