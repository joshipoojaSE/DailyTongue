// Scene practice: the learner plays one character of a saved scene and Kai plays the other.
// A spoken line is transcribed by OpenAI, with the script line as context, then checked in
// the browser. Kai's lines play from stored audio (or the browser's own speech). Ila, the
// tutor, stays out of scenes.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { finishRun, getScene, sceneLineAudioUrl, startRun, transcribeAudio } from "./api.js";
import { BackButton, KeyboardIcon, MicIcon } from "./common.jsx";
import { compareLines } from "./scene.js";
import Tongue from "./Tongue.jsx";
import { useActiveWhile } from "./usePracticeTimer.js";
import { SILENCE_MS, useRecorder } from "./useRecorder.js";

const recordingSupported =
  typeof window !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

// Whether to show the learner's next line, or hide it so they say it from memory.
const SHOW_LINE_KEY = "dailytongue.showLine";

function loadShowLine() {
  try {
    return localStorage.getItem(SHOW_LINE_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveShowLine(show) {
  try {
    localStorage.setItem(SHOW_LINE_KEY, String(show));
  } catch {
    // Storage is unavailable; the setting just won't be remembered.
  }
}

// Below this score the word-by-word marks are hidden; only the script line is shown.
const MIN_DIFF_SCORE = 0.4;

const percent = (score) => `${Math.round(score * 100)}%`;

// The browser's own speech, free and offline-capable: a different voice for each character
// where the browser has two English voices, and a different pitch either way.
function speakInBrowser(text, character) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) {
      resolve();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
    if (voices.length) utterance.voice = voices[Math.min(character, voices.length - 1)];
    utterance.lang = utterance.voice?.lang ?? "en-IN";
    utterance.rate = 0.95;
    utterance.pitch = character === 0 ? 1.1 : 0.85;
    utterance.onend = utterance.onerror = () => resolve();
    synth.cancel();
    synth.speak(utterance);
  });
}

// What the learner said against the script: matching words plain, and the rest marked.
function LineDiff({ ops }) {
  return (
    <p className="diff">
      {ops.map((op, i) => (
        <Fragment key={i}>
          {op.type === "same" && <span>{op.expected}</span>}
          {op.type === "missed" && (
            <span className="diff-missed" title="Missed: this word is in the script">
              {op.expected}
            </span>
          )}
          {op.type === "extra" && (
            <span className="diff-extra" title="Extra: this word isn't in the script">
              {op.said}
            </span>
          )}
          {op.type === "changed" && (
            <span className="diff-changed" title={`Changed: the script says "${op.expected}"`}>
              <s>{op.said}</s> <strong>{op.expected}</strong>
            </span>
          )}{" "}
        </Fragment>
      ))}
    </p>
  );
}

function LineResult({ result, threshold }) {
  const { score, ops } = result;
  const [tier, label] =
    score >= 0.9
      ? ["great", score === 1 ? "Spot on!" : "Great!"]
      : score >= threshold
        ? ["good", "Nearly there"]
        : ["off", "Off-script"];

  return (
    <div className={`line-result ${tier}`}>
      <div className="line-result-head">
        <span className="score">{percent(score)}</span>
        <span>{label}</span>
      </div>
      {score < threshold && (
        <p className="diff">
          The script says: <strong>{result.expected}</strong>
        </p>
      )}
      {/* Very far from the script, word-by-word marks are just noise. */}
      {score < 1 && score >= MIN_DIFF_SCORE && (
        <>
          <LineDiff ops={ops} />
          <ul className="diff-legend" aria-hidden="true">
            <li className="diff-missed">missed</li>
            <li className="diff-extra">extra</li>
            <li className="diff-changed">
              <strong>changed</strong>
            </li>
          </ul>
        </>
      )}
    </div>
  );
}

function Summary({ summary, role, partner, onAgain, onSwitch, onBack }) {
  const { avg, weakest, count } = summary;
  return (
    <section className="card summary">
      <Tongue size={72} mood={avg >= 0.7 ? "happy" : "rest"} />
      <h3>Scene complete!</h3>
      <p className="summary-score">
        <span>{percent(avg)}</span> average across your {count} {count === 1 ? "line" : "lines"}{" "}
        as {role}
      </p>
      {weakest.length > 0 ? (
        <>
          <h4>Lines to work on</h4>
          <ul className="weak-lines">
            {weakest.map(({ line, result }) => (
              <li key={line.id}>
                <span className="score">{percent(result.score)}</span>
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>Every line word-perfect. Brilliant!</p>
      )}
      <div className="summary-actions">
        <button type="button" className="pill primary" onClick={onAgain}>
          Practice again
        </button>
        <button type="button" className="pill" onClick={onSwitch}>
          Switch role (play {partner})
        </button>
        <button type="button" className="pill quiet" onClick={onBack}>
          My Scenes
        </button>
      </div>
    </section>
  );
}

/**
 * config: { scene_tts_provider, offscript_threshold } from the backend.
 * markActive / activeSeconds: from the practice timer.
 * onMoodChange(mood): what the header mascot should show.
 */
export default function ScenePractice({
  sceneId,
  initialRole,
  config,
  markActive,
  activeSeconds,
  onBack,
  onMoodChange,
}) {
  const [scene, setScene] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [role, setRole] = useState(initialRole);
  // The line the scene has reached.
  const [index, setIndex] = useState(0);
  // "loading" | "partner" (Kai is saying a line) | "mine" (the learner's turn) | "done"
  const [phase, setPhase] = useState("loading");
  // The learner's attempt at each of their lines, by index:
  // { expected, said, input, score, ops }.
  const [results, setResults] = useState({});
  const resultsRef = useRef({});
  const [summary, setSummary] = useState(null);
  const [draft, setDraft] = useState("");
  const [showLine, setShowLine] = useState(loadShowLine);
  const [error, setError] = useState("");
  // The id of the line being played, if any.
  const [playingId, setPlayingId] = useState(null);
  // Whether a spoken line is being transcribed.
  const [transcribing, setTranscribing] = useState(false);
  // The current run. token changes on each restart, so callbacks from an earlier run stop.
  const runRef = useRef({ token: 0, run: null, startSeconds: 0 });
  const audioRef = useRef(null);
  // Audio elements by line id, so each line is fetched once per visit.
  const audioCache = useRef(new Map());
  // Ids of lines whose audio was made in the background this visit.
  const madeAudio = useRef(new Set());
  const bottomRef = useRef(null);

  const provider = config?.scene_tts_provider ?? "openai_cached";
  const threshold = config?.offscript_threshold ?? 0.7;

  const { isRecording, hasSpoken, levels, start, stop, cancel } = useRecorder({
    onSilence: finishRecording,
    onNoSpeech: stopListening,
  });

  // Listening to Kai's lines (or hearing your own), and saying yours, are practice too.
  useActiveWhile(playingId !== null || isRecording, markActive);

  useEffect(() => {
    let ignore = false;
    getScene(sceneId)
      .then((data) => {
        if (!ignore) setScene(data);
      })
      .catch(() => {
        if (!ignore) setLoadError(true);
      });
    return () => {
      ignore = true;
    };
  }, [sceneId]);

  // Start once the scene is loaded.
  useEffect(() => {
    if (scene) begin(initialRole);
  }, [scene]);

  // Leaving stops Kai mid-line and ends the run (unfinished runs aren't counted).
  useEffect(
    () => () => {
      runRef.current.token++;
      stopAudio();
    },
    []
  );

  // The browser loads its voices lazily; asking early means they're ready for the first line.
  useEffect(() => {
    if (provider === "browser") window.speechSynthesis?.getVoices();
  }, [provider]);

  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [index, phase, results]);

  const mood = isRecording
    ? "listening"
    : transcribing
      ? "thinking"
      : playingId
      ? "talking"
      : phase === "done"
        ? "happy"
        : error
          ? "oops"
          : "idle";
  useEffect(() => onMoodChange?.(mood), [mood]);

  function setResult(i, changes) {
    resultsRef.current = { ...resultsRef.current, [i]: { ...resultsRef.current[i], ...changes } };
    setResults(resultsRef.current);
  }

  function stopAudio() {
    audioRef.current?.pause();
    window.speechSynthesis?.cancel();
  }

  function audioFor(line) {
    let audio = audioCache.current.get(line.id);
    if (!audio) {
      audio = new Audio(sceneLineAudioUrl(scene.id, line.id));
      audio.preload = "auto";
      audioCache.current.set(line.id, audio);
    }
    return audio;
  }

  // Fetches the audio of Kai's next line after index `from` while the learner is busy.
  function preloadFrom(from, currentRole) {
    if (provider !== "openai_cached") return;
    const next = scene.lines.slice(from).find((l) => l.speaker !== currentRole);
    if (next) audioFor(next);
  }

  // Has the audio of the learner's own lines made in the background, one at a time, so they
  // can hear their line now and switching roles later needs no OpenAI request. Kai's lines
  // are fetched as they come up, by preloadFrom.
  async function makeAudioFor(currentRole, token) {
    if (provider !== "openai_cached") return;
    const lines = scene.lines.filter((l) => l.speaker === currentRole && !l.has_audio);
    for (const line of lines) {
      // Stop when the run ends; anything left is made when it's first played.
      if (runRef.current.token !== token) return;
      if (madeAudio.current.has(line.id) || audioCache.current.has(line.id)) continue;
      try {
        const res = await fetch(sceneLineAudioUrl(scene.id, line.id));
        if (res.ok) madeAudio.current.add(line.id);
      } catch {
        // It's made when it's first played instead.
      }
    }
  }

  // Plays a line in its character's voice; resolves when it ends, is stopped or fails.
  function playLine(line) {
    stopAudio();
    setPlayingId(line.id);
    const done =
      provider === "browser"
        ? speakInBrowser(line.text, scene.characters.indexOf(line.speaker))
        : new Promise((resolve) => {
            const audio = audioFor(line);
            audioRef.current = audio;
            const finish = () => {
              audio.onended = audio.onpause = audio.onerror = null;
              resolve();
            };
            audio.onended = audio.onpause = finish;
            audio.onerror = () => {
              setError("Couldn't play Kai's line, so have a read of it instead.");
              finish();
            };
            audio.currentTime = 0;
            audio.play().catch(() => {
              setError("Couldn't play Kai's line, so have a read of it instead.");
              finish();
            });
          });
    return done.finally(() => setPlayingId((id) => (id === line.id ? null : id)));
  }

  function begin(nextRole) {
    stopAudio();
    cancel();
    const token = runRef.current.token + 1;
    const run = startRun(scene.id, nextRole);
    run.catch(() => {
      if (runRef.current.token === token)
        setError("Couldn't start a practice run, so this one won't be counted.");
    });
    runRef.current = { token, run, startSeconds: activeSeconds() };
    resultsRef.current = {};
    setResults({});
    setSummary(null);
    setDraft("");
    setError("");
    setRole(nextRole);
    goTo(0, nextRole, token);
    makeAudioFor(nextRole, token);
  }

  function goTo(i, currentRole, token) {
    if (runRef.current.token !== token) return;
    if (i >= scene.lines.length) {
      finish(currentRole, token);
      return;
    }
    setIndex(i);
    preloadFrom(i + 1, currentRole);
    const line = scene.lines[i];
    if (line.speaker === currentRole) {
      setPhase("mine");
      return;
    }
    setPhase("partner");
    playLine(line).then(() => goTo(i + 1, currentRole, token));
  }

  function submit(text, input) {
    if (phase !== "mine") return;
    const { token } = runRef.current;
    const line = scene.lines[index];
    const { score, ops } = compareLines(line.text, text);
    setResult(index, { expected: line.text, said: text, input, score, ops });
    setDraft("");
    setError("");
    markActive();
    goTo(index + 1, role, token);
  }

  function finish(currentRole, token) {
    setPhase("done");
    const mine = scene.lines
      .map((line, i) => ({ line, result: resultsRef.current[i] }))
      .filter(({ line, result }) => line.speaker === currentRole && result);
    const avg = mine.length ? mine.reduce((sum, m) => sum + m.result.score, 0) / mine.length : 0;
    const weakest = mine
      .filter((m) => m.result.score < 1)
      .sort((a, b) => a.result.score - b.result.score)
      .slice(0, 3);
    setSummary({ avg, weakest, count: mine.length });

    const seconds = Math.max(0, activeSeconds() - runRef.current.startSeconds);
    runRef.current.run
      .then((run) => finishRun(run.id, avg, seconds))
      .catch(() => {
        if (runRef.current.token === token) setError("Couldn't save this run's result.");
      });
  }

  function toggleLine() {
    setShowLine((show) => {
      saveShowLine(!show);
      return !show;
    });
  }

  function submitText(e) {
    e.preventDefault();
    const text = draft.trim();
    if (text) submit(text, "typed");
  }

  async function startListening() {
    setError("");
    try {
      await start();
    } catch {
      setError("Microphone access was denied or is unavailable. Type your line instead.");
    }
  }

  async function finishRecording() {
    const { token } = runRef.current;
    const line = scene.lines[index];
    const result = await stop();
    if (!result || result.blob.size === 0) return;
    setTranscribing(true);
    try {
      const { transcript } = await transcribeAudio(result.blob, result.filename, line.text);
      if (runRef.current.token !== token) return;
      if (transcript.trim()) submit(transcript.trim(), "spoken");
      else setError("I didn't catch that. Tap the mic to try again, or type your line.");
    } catch (err) {
      if (runRef.current.token === token)
        setError(err.message || "Couldn't check that line. Try again, or type it.");
    } finally {
      setTranscribing(false);
    }
  }

  // Nothing was said after tapping the mic, so there's nothing worth transcribing.
  function stopListening() {
    cancel();
    setError("I didn't hear anything, so I stopped listening. Tap the mic to try again.");
  }

  if (loadError || !scene) {
    return (
      <main className="dashboard">
        <div className="container dashboard-inner">
          <BackButton onClick={onBack}>My Scenes</BackButton>
          <div className="empty">
            <Tongue size={96} mood={loadError ? "oops" : "thinking"} />
            <p>{loadError ? "Couldn't load this scene." : "Loading your scene…"}</p>
          </div>
        </div>
      </main>
    );
  }

  const partner = scene.characters.find((c) => c !== role);
  const myLineCount = scene.lines.filter((l) => l.speaker === role).length;
  const myLineNumber = scene.lines.slice(0, index + 1).filter((l) => l.speaker === role).length;
  // Lines in the transcript so far: Kai's current line shows while it plays, the learner's
  // once they've said it.
  const shown = phase === "done" ? scene.lines.length : phase === "partner" ? index + 1 : index;
  const current = scene.lines[index];
  const shownError = error;
  const micLevel = levels[levels.length - 1];

  return (
    <>
      <main className="chat practice">
        <div className="container chat-inner">
          <div className="practice-head">
            <BackButton onClick={onBack}>My Scenes</BackButton>
            <h2>{scene.title}</h2>
            <p>
              You play <strong>{role}</strong> · Kai plays <strong>{partner}</strong>
              {provider === "browser" && " · browser voices"}
            </p>
          </div>

          {scene.lines.slice(0, shown).map((line, i) => {
            if (line.speaker !== role) {
              return (
                <div key={line.id} className="message assistant">
                  <span className="meta">
                    <Tongue size={22} mood={playingId === line.id ? "talking" : "rest"} />
                    Kai as {line.speaker}
                  </span>
                  <div className="bubble assistant">
                    <p>{line.text}</p>
                    {phase !== "partner" && (
                      <button
                        type="button"
                        className="replay"
                        onClick={() => playLine(line)}
                        disabled={playingId !== null}
                      >
                        Hear it again
                      </button>
                    )}
                  </div>
                </div>
              );
            }
            const result = results[i];
            if (!result) return null;
            return (
              <Fragment key={line.id}>
                <div className="message user">
                  <span className="meta">
                    {result.input === "spoken" ? <MicIcon size={14} /> : <KeyboardIcon size={15} />}
                    You as {role} · {result.input}
                  </span>
                  <div className="bubble user">
                    <p>{result.said}</p>
                  </div>
                </div>
                <LineResult result={result} threshold={threshold} />
              </Fragment>
            );
          })}

          {phase === "done" && summary && (
            <Summary
              summary={summary}
              role={role}
              partner={partner}
              onAgain={() => begin(role)}
              onSwitch={() => begin(partner)}
              onBack={onBack}
            />
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      {phase === "partner" && (
        <footer className="container controls">
          <div className="speaking-bar" role="status">
            <Tongue size={34} mood="talking" />
            <span>
              Kai is saying {partner}'s line… your turn is next.
            </span>
            <button type="button" className="pill quiet" onClick={stopAudio}>
              Skip
            </button>
          </div>
        </footer>
      )}

      {phase === "mine" && (
        <footer className="container controls">
          {shownError && (
            <div className="error">
              <Tongue size={28} mood="oops" />
              {shownError}
            </div>
          )}

          <div className="line-card">
            <div className="line-card-head">
              <span>
                Your line as {role} · {myLineNumber} of {myLineCount}
              </span>
              <span className="line-card-buttons">
                <button
                  type="button"
                  className="line-toggle"
                  onClick={() => playLine(current)}
                  disabled={playingId !== null || isRecording || transcribing}
                >
                  {playingId === current.id ? "Playing…" : "Hear it"}
                </button>
                <button
                  type="button"
                  className="line-toggle"
                  onClick={toggleLine}
                  aria-pressed={!showLine}
                >
                  {showLine ? "Hide line" : "Show line"}
                </button>
              </span>
            </div>
            {showLine ? (
              <p className="line-text">{current.text}</p>
            ) : (
              <p className="line-text hidden-line">
                Say it from memory · {current.text.split(/\s+/).length} words
              </p>
            )}
          </div>

          <form className={`composer ${isRecording ? "recording" : ""}`} onSubmit={submitText}>
            {transcribing ? (
              <div className="listening" role="status">
                <Tongue size={40} mood="thinking" />
                <div className="listening-body">
                  <p className="listening-hint">Checking your line…</p>
                </div>
              </div>
            ) : isRecording ? (
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
                        ? `Tap ■ when you've finished, or I'll stop after ${SILENCE_MS / 1000} seconds of quiet`
                        : "Listening… take your time and say the whole line"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="cancel"
                  onClick={cancel}
                  aria-label="Cancel listening"
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
                  placeholder={
                    recordingSupported
                      ? "Say your line, or type it"
                      : "Type your line (this browser can't record)"
                  }
                  aria-label="Your line"
                  autoFocus={!recordingSupported}
                />
                <button
                  type="submit"
                  className="send"
                  disabled={!draft.trim()}
                  aria-label="Check my line"
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
              onClick={isRecording ? finishRecording : startListening}
              disabled={!recordingSupported || transcribing}
              aria-label={isRecording ? "Stop listening" : "Say your line"}
              title={recordingSupported ? undefined : "Recording isn't supported in this browser"}
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
      )}
    </>
  );
}
