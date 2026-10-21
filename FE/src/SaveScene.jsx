// Turning a dialogue in the chat into a saved scene. Kai's message is parsed in the browser,
// so saving makes no OpenAI request.
import { useState } from "react";
import { createScene, writeNewScene } from "./api.js";

function SceneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9Zm0 0 1.2-4.2a1 1 0 0 1 1.2-.7L19 7.4M8.5 4.9 10 8.6M13.5 6.2 15 9"
      />
    </svg>
  );
}

/**
 * dialogue: { characters, lines } parsed from the message. scene: the JSON Kai wrote, if it
 * wrote one (its title, situation and topic are kept). savedId: the scene already saved from
 * this message, if any.
 */
export function SaveScene({ dialogue, scene, messageId, suggestedTitle, savedId, onSaved, onOpen }) {
  // "idle" | "editing" | "saving"
  const [state, setState] = useState("idle");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");

  if (savedId) {
    return (
      <div className="save-scene saved">
        <span>Saved to My Scenes</span>
        <button type="button" className="pill primary" onClick={() => onOpen(savedId)}>
          Practice it
        </button>
      </div>
    );
  }

  if (state === "idle") {
    return (
      <div className="save-scene">
        <button
          type="button"
          className="pill"
          onClick={() => {
            setTitle(scene?.title || suggestedTitle);
            setState("editing");
          }}
        >
          <SceneIcon />
          Save as scene
        </button>
        <span className="save-scene-hint">
          {dialogue.characters.join(" & ")} · {dialogue.lines.length} lines
        </span>
      </div>
    );
  }

  async function save(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setState("saving");
    setError("");
    try {
      const saved = await createScene({
        title: title.trim(),
        situation: scene?.situation ?? "",
        topic: scene?.topic ?? "",
        characters: dialogue.characters,
        lines: dialogue.lines,
        source_message_id: messageId ?? null,
      });
      onSaved(saved);
    } catch (err) {
      setError(err.message || "Couldn't save the scene");
      setState("editing");
    }
  }

  return (
    <form className="save-scene editing" onSubmit={save}>
      <label>
        <span>Scene title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          autoFocus
          disabled={state === "saving"}
        />
      </label>
      <div className="save-scene-buttons">
        <button type="submit" className="pill primary" disabled={!title.trim() || state === "saving"}>
          {state === "saving" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="pill quiet"
          onClick={() => setState("idle")}
          disabled={state === "saving"}
        >
          Cancel
        </button>
      </div>
      {error && <p className="scene-error">{error}</p>}
    </form>
  );
}

/**
 * Kai found a saved scene matching the request: open it, or have a new one written anyway.
 * onWritten({ message_id, response, scene }) gets the new scene's message.
 */
export function ExistingScene({ existing, sceneRequest, conversationId, learnerRequest, onOpen, onWritten }) {
  // "idle" | "writing" | "error" | "written"
  const [state, setState] = useState("idle");

  async function writeNew() {
    setState("writing");
    try {
      onWritten(await writeNewScene(conversationId, sceneRequest, learnerRequest));
      setState("written");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="save-scene">
      <button type="button" className="pill primary" onClick={() => onOpen(existing.id)}>
        Open “{existing.title}”
      </button>
      {sceneRequest && state !== "written" && (
        <button type="button" className="pill" onClick={writeNew} disabled={state === "writing"}>
          {state === "writing"
            ? "Writing…"
            : state === "error"
              ? "Couldn't write it. Try again"
              : "Write a new one"}
        </button>
      )}
    </div>
  );
}
