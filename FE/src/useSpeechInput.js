import { useEffect, useRef, useState } from "react";

// The browser's own speech recognition (Web Speech API), used in scene practice so a line
// can be checked without sending audio to OpenAI. Chrome and Edge have it; Firefox doesn't,
// and there the learner types instead.
const Recognition =
  typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);

export const speechSupported = Boolean(Recognition);

// Once the learner has said something, this much quiet means they've finished the line.
// It's generous, since learners pause mid-line to think.
export const LINE_SILENCE_MS = 4000;
// If nothing has been said by then, listening gives up.
const NO_SPEECH_MS = 10000;

/**
 * Listens for one spoken line, however long, until the learner stops (LINE_SILENCE_MS of
 * quiet after speaking) or taps stop.
 *
 * onResult(text) gets what was heard ("" if nothing was); onSpeech() is called as words come
 * in. Returns { listening, heard (the words so far), error, start, stop, cancel }.
 */
export function useSpeechInput({ onResult, onSpeech, lang = "en-IN" }) {
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [error, setError] = useState("");
  // The current attempt: { recognition, done, cancelled, text, timer }.
  const sessionRef = useRef(null);
  // The latest callbacks, so a recognition started on an earlier render calls current ones.
  const callbacks = useRef({ onResult, onSpeech });
  callbacks.current = { onResult, onSpeech };

  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (session) {
        session.cancelled = session.done = true;
        clearTimeout(session.timer);
        session.recognition.abort();
      }
    },
    []
  );

  // Ends the attempt: the recognition stops, and onend reports what was heard.
  function finish(session) {
    session.done = true;
    clearTimeout(session.timer);
    session.recognition.stop();
  }

  function waitFor(session, ms) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => finish(session), ms);
  }

  // Chrome ends a recognition after a pause or a minute, whatever `continuous` says, so a
  // fresh one is started for the same attempt until the learner has finished.
  function listen(session) {
    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;
    session.recognition = recognition;
    // Words from this recognition; the text from earlier ones is in session.text.
    let words = "";

    recognition.onresult = (e) => {
      words = Array.from(e.results, (result) => result[0].transcript).join(" ");
      setHeard(`${session.text} ${words}`.replace(/\s+/g, " ").trim());
      waitFor(session, LINE_SILENCE_MS);
      callbacks.current.onSpeech?.();
    };
    recognition.onerror = (e) => {
      if (e.error === "aborted" || e.error === "no-speech") return;
      session.done = true;
      if (e.error === "not-allowed" || e.error === "service-not-allowed")
        setError("Microphone access was denied. Type your line instead.");
      else setError("Couldn't hear that. Try again, or type it.");
    };
    recognition.onend = () => {
      session.text = `${session.text} ${words}`.replace(/\s+/g, " ").trim();
      if (!session.done) {
        listen(session);
        return;
      }
      clearTimeout(session.timer);
      sessionRef.current = null;
      setListening(false);
      setHeard("");
      if (!session.cancelled) callbacks.current.onResult(session.text);
    };
    recognition.start();
  }

  function start() {
    if (!Recognition || sessionRef.current) return;
    const session = { done: false, cancelled: false, text: "", timer: null, recognition: null };
    sessionRef.current = session;
    setError("");
    setHeard("");
    setListening(true);
    listen(session);
    waitFor(session, NO_SPEECH_MS);
  }

  return {
    listening,
    heard,
    error,
    start,
    // Finished early: check what's been heard so far.
    stop: () => sessionRef.current && finish(sessionRef.current),
    cancel: () => {
      const session = sessionRef.current;
      if (!session) return;
      session.cancelled = true;
      finish(session);
    },
  };
}
