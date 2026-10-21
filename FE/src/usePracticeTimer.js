import { useCallback, useEffect, useRef, useState } from "react";
import { beaconActivity, getActivityToday, sendActivity } from "./api.js";

// With no speaking or typing for this long, the learner has stepped away and the timer pauses.
export const IDLE_MS = 90 * 1000;
const HEARTBEAT_MS = 15 * 1000;
// The most the backend takes in one heartbeat; anything over waits for the next one.
const MAX_HEARTBEAT_SECONDS = 120;

// A key press that types into a text box. Shortcuts and keys pressed elsewhere aren't practice.
function isTyping(e) {
  const target = e.target;
  const field =
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  const editing = e.key.length === 1 || e.key === "Backspace" || e.key === "Delete";
  return field && editing && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/**
 * Keeps the learner active while `active` is true, e.g. while Kai is speaking: listening to
 * Kai is practice too, so a long reply doesn't count as having stepped away.
 */
export function useActiveWhile(active, markActive) {
  useEffect(() => {
    if (!active) return;
    markActive();
    const timer = setInterval(markActive, 1000);
    return () => {
      clearInterval(timer);
      // Up to the moment it stopped.
      markActive();
    };
  }, [active, markActive]);
}

/**
 * Times the learner's own practice, not API requests or time with the app open. It counts
 * a second whenever `mode` ("free_talk" | "scene") is set and the tab is visible, but only
 * keeps the seconds between the learner's speaking, typing or listening to Kai (see
 * useActiveWhile): the seconds since then are added when they're active again, and dropped
 * if 90 seconds pass first (they stepped away). Waiting for a reply or reading between lines
 * therefore counts; opening a view and leaving doesn't. null mode stops it. Every 15 seconds the kept seconds go to
 * the backend, which keeps the day's total, so it survives a reload.
 *
 * getConversationId() gives the learner's conversation id (null before their first message);
 * the seconds are stored under it.
 *
 * Returns:
 *   today        { seconds, goal_minutes } including seconds not yet sent, or null at first
 *   running      whether it's counting right now
 *   markActive() call when the learner speaks (typing in a text box is noticed by itself)
 *   activeSeconds() seconds counted since the page loaded, to time a stretch of practice
 */
export function usePracticeTimer(mode, sceneId, getConversationId) {
  // Today's total as the backend last reported it.
  const [saved, setSaved] = useState(null);
  // Seconds counted but not yet in `saved`: waiting to be sent, or on their way.
  const [pending, setPending] = useState(0);
  const [running, setRunning] = useState(false);
  const unsentRef = useRef(0);
  const sendingRef = useRef(0);
  const lastActiveRef = useRef(0);
  // Seconds since the learner last spoke or typed, kept only if they do so again in time.
  const heldRef = useRef(0);
  const totalRef = useRef(0);
  const modeRef = useRef({ mode, sceneId });
  const conversationRef = useRef(getConversationId);
  conversationRef.current = getConversationId;

  const markActive = useCallback(() => {
    lastActiveRef.current = Date.now();
    if (heldRef.current) {
      unsentRef.current += heldRef.current;
      totalRef.current += heldRef.current;
      heldRef.current = 0;
      setPending(unsentRef.current + sendingRef.current);
    }
  }, []);

  const flush = useCallback(async () => {
    const seconds = Math.min(unsentRef.current, MAX_HEARTBEAT_SECONDS);
    if (!seconds) return;
    // Read before awaiting, so the seconds go to the mode they were counted in.
    const { mode, sceneId } = modeRef.current;
    unsentRef.current -= seconds;
    sendingRef.current += seconds;
    try {
      setSaved(
        await sendActivity(seconds, mode ?? "free_talk", sceneId, conversationRef.current?.())
      );
    } catch {
      // Try again with the next heartbeat.
      unsentRef.current += seconds;
    } finally {
      sendingRef.current -= seconds;
      setPending(unsentRef.current + sendingRef.current);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    getActivityToday()
      .then((data) => {
        if (!ignore) setSaved(data);
      })
      .catch(() => {
        // The goal is a nice-to-have; practice works without it.
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    function keyDown(e) {
      if (isTyping(e)) markActive();
    }
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [markActive]);

  // Seconds from before a change of mode are sent under the old one.
  useEffect(() => {
    flush();
    modeRef.current = { mode, sceneId };
  }, [mode, sceneId, flush]);

  useEffect(() => {
    if (!mode) {
      setRunning(false);
      return;
    }
    const tick = setInterval(() => {
      const recent = Date.now() - lastActiveRef.current < IDLE_MS;
      // Idle too long: the learner stepped away, so the held seconds don't count.
      if (!recent) heldRef.current = 0;
      const counting = recent && document.visibilityState === "visible";
      setRunning(counting);
      if (counting) heldRef.current += 1;
    }, 1000);
    return () => clearInterval(tick);
  }, [mode]);

  useEffect(() => {
    const heartbeat = setInterval(flush, HEARTBEAT_MS);
    function visibilityChange() {
      if (document.visibilityState === "hidden") flush();
    }
    // A fetch may not finish while the page closes, but a beacon is sent regardless.
    function pageHide() {
      const seconds = Math.min(unsentRef.current, MAX_HEARTBEAT_SECONDS);
      const { mode, sceneId } = modeRef.current;
      const conversationId = conversationRef.current?.();
      if (seconds && beaconActivity(seconds, mode ?? "free_talk", sceneId, conversationId)) {
        unsentRef.current -= seconds;
      }
    }
    document.addEventListener("visibilitychange", visibilityChange);
    window.addEventListener("pagehide", pageHide);
    return () => {
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", visibilityChange);
      window.removeEventListener("pagehide", pageHide);
    };
  }, [flush]);

  const activeSeconds = useCallback(() => totalRef.current, []);

  return {
    today: saved && { seconds: saved.seconds + pending, goal_minutes: saved.goal_minutes },
    running,
    markActive,
    activeSeconds,
  };
}
