// My Scenes: the dialogues the learner saved from chat, to practise as either character.
import { useEffect, useRef, useState } from "react";
import { deleteScene, getScenes, renameScene } from "./api.js";
import { BackButton, parseServerTime } from "./common.jsx";
import Tongue from "./Tongue.jsx";

const practisedFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  day: "numeric",
  month: "short",
});

function practiceLabel(scene) {
  if (!scene.practice_count) return "Not practised yet";
  const times = scene.practice_count === 1 ? "once" : `${scene.practice_count} times`;
  return `Practised ${times} · last ${practisedFormat.format(parseServerTime(scene.last_practiced_at))}`;
}

function SceneCard({ scene, focused, onPractice, onRenamed, onDeleted }) {
  // "idle" | "renaming" | "confirm-delete" | "busy"
  const [mode, setMode] = useState("idle");
  const [title, setTitle] = useState(scene.title);
  const [error, setError] = useState("");
  const ref = useRef(null);
  const [a, b] = scene.characters;

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);

  async function rename(e) {
    e.preventDefault();
    const next = title.trim();
    if (!next) return;
    setMode("busy");
    try {
      onRenamed(await renameScene(scene.id, next));
      setMode("idle");
      setError("");
    } catch (err) {
      setError(err.message || "Couldn't rename the scene");
      setMode("renaming");
    }
  }

  async function remove() {
    setMode("busy");
    try {
      await deleteScene(scene.id);
      onDeleted(scene.id);
    } catch (err) {
      setError(err.message || "Couldn't delete the scene");
      setMode("idle");
    }
  }

  return (
    <li className={`scene-card ${focused ? "focused" : ""}`} ref={ref}>
      {mode === "renaming" ? (
        <form className="scene-rename" onSubmit={rename}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            aria-label="Scene title"
            autoFocus
          />
          <button type="submit" className="pill" disabled={!title.trim()}>
            Save
          </button>
          <button
            type="button"
            className="pill quiet"
            onClick={() => {
              setTitle(scene.title);
              setMode("idle");
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <h3>{scene.title}</h3>
      )}

      <p className="scene-meta">
        <span>
          {a} &amp; {b}
        </span>
        <span>{scene.line_count} lines</span>
        <span>{practiceLabel(scene)}</span>
      </p>

      {error && <p className="scene-error">{error}</p>}

      {mode === "confirm-delete" ? (
        <div className="scene-actions">
          <span className="scene-confirm">Delete this scene and its audio?</span>
          <button type="button" className="pill danger" onClick={remove}>
            Delete
          </button>
          <button type="button" className="pill quiet" onClick={() => setMode("idle")}>
            Keep it
          </button>
        </div>
      ) : (
        <div className="scene-actions">
          {[a, b].map((role) => (
            <button
              key={role}
              type="button"
              className="pill primary"
              onClick={() => onPractice(scene.id, role)}
              disabled={mode === "busy"}
            >
              Practice as {role}
            </button>
          ))}
          <span className="scene-tools">
            <button
              type="button"
              className="pill quiet"
              onClick={() => setMode("renaming")}
              disabled={mode !== "idle"}
            >
              Rename
            </button>
            <button
              type="button"
              className="pill quiet"
              onClick={() => setMode("confirm-delete")}
              disabled={mode !== "idle"}
            >
              Delete
            </button>
          </span>
        </div>
      )}
    </li>
  );
}

export default function SceneLibrary({ focusId, onPractice, onBack }) {
  const [scenes, setScenes] = useState(null);
  const [status, setStatus] = useState("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let ignore = false;
    setStatus("loading");
    getScenes()
      .then((data) => {
        if (ignore) return;
        setScenes(data);
        setStatus("done");
      })
      .catch(() => {
        if (!ignore) setStatus("error");
      });
    return () => {
      ignore = true;
    };
  }, [attempt]);

  let body;
  if (!scenes) {
    body =
      status === "error" ? (
        <div className="empty">
          <Tongue size={96} mood="oops" />
          <p>Couldn't load your scenes.</p>
          <button type="button" className="retry" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <div className="empty">
          <Tongue size={96} mood="thinking" />
          <p>Loading your scenes…</p>
        </div>
      );
  } else if (scenes.length === 0) {
    body = (
      <div className="empty">
        <Tongue size={96} mood="happy" />
        <p>
          No scenes yet. Ask Kai for a dialogue between two characters, then tap{" "}
          <strong>Save as scene</strong>.
        </p>
      </div>
    );
  } else {
    body = (
      <ul className="scene-list">
        {scenes.map((scene) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            focused={scene.id === focusId}
            onPractice={onPractice}
            onRenamed={(updated) =>
              setScenes((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)))
            }
            onDeleted={(id) => setScenes((prev) => prev.filter((s) => s.id !== id))}
          />
        ))}
      </ul>
    );
  }

  return (
    <main className="dashboard">
      <div className="container dashboard-inner">
        <BackButton onClick={onBack}>Back to chat</BackButton>
        <div className="dashboard-heading">
          <h2>My Scenes</h2>
        </div>
        {body}
      </div>
    </main>
  );
}
