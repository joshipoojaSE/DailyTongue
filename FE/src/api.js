const API_BASE = import.meta.env.VITE_API_BASE || "/api";

async function request(path, options) {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", ...options });
  return parse(res);
}

async function parse(res) {

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new Error(message);
  }

  return res.json();
}

/** Sends recorded audio; resolves to { transcript }. */
export function transcribeAudio(blob, filename) {
  const form = new FormData();
  form.append("audio", blob, filename);
  return request("/transcribe", { body: form });
}

/**
 * Sends the conversation so far ([{ role, content }], ending with the user's
 * latest message); resolves to
 * { response, audio_base64, conversation_id, user_message_id, message_id,
 *   scene, existing_scene, scene_request }. scene is set when Kai wrote a dialogue;
 * existing_scene ({ id, title }) and scene_request when a saved scene already matched.
 * Pass null as conversationId on the first turn; the server assigns one.
 * input ("spoken" | "typed") is how the user entered their latest message.
 */
export function getReply(messages, conversationId, input) {
  return request("/respond", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, conversation_id: conversationId, input }),
  });
}

/** Reads text aloud in Ila's (the tutor's) voice; resolves to { audio_base64 } (MP3). */
export function speak(text) {
  return request("/speak", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

/**
 * Asks the tutor to check the user's latest message in the conversation
 * ([{ role, content }], which may end with Kai's reply); resolves to
 * { id, message, corrected, mistakes: [{ original, correction, explanation }], rephrased, created_at }.
 * messageId is that message's stored id, so the feedback shows up in history.
 */
export function getFeedback(conversationId, messages, messageId) {
  return request(`/conversations/${encodeURIComponent(conversationId)}/feedback`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, message_id: messageId }),
  });
}

/**
 * Loads a page of stored messages, oldest first: the newest ones, or those older
 * than the message id `before`. Resolves to
 * { messages: [{ id, role, content, has_audio, feedback, created_at }], has_more }.
 */
export async function getMessages(conversationId, before) {
  const params = new URLSearchParams();
  if (before != null) params.set("before", before);
  const res = await fetch(
    `${API_BASE}/conversations/${encodeURIComponent(conversationId)}/messages?${params}`
  );
  return parse(res);
}

async function get(path) {
  return parse(await fetch(`${API_BASE}${path}`));
}

function sendJson(path, body, method = "POST") {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** URL of the MP3 for one of Kai's stored replies. */
export function messageAudioUrl(messageId) {
  return `${API_BASE}/messages/${messageId}/audio`;
}

/** Resolves to { scene_tts_provider: "openai_cached" | "browser", offscript_threshold, goal_minutes }. */
export function getConfig() {
  return get("/config");
}

// --- Scenes --------------------------------------------------------------------------

/**
 * Saves a dialogue as a scene: { title, characters: [a, b], lines: [{ speaker, text }],
 * situation?, topic?, source_message_id? }. Resolves to the scene with its lines.
 */
export function createScene(scene) {
  return sendJson("/scenes", scene);
}

/**
 * Resolves to the saved scenes: [{ id, title, situation, topic, characters, line_count,
 * practice_count, source_message_id, last_practiced_at, created_at }], latest first.
 */
export function getScenes() {
  return get("/scenes");
}

/** Resolves to a scene with its lines: [{ id, line_no, speaker, text, voice, has_audio }]. */
export function getScene(sceneId) {
  return get(`/scenes/${sceneId}`);
}

export function renameScene(sceneId, title) {
  return sendJson(`/scenes/${sceneId}`, { title }, "PATCH");
}

export function deleteScene(sceneId) {
  return request(`/scenes/${sceneId}`, { method: "DELETE" });
}

/** URL of a scene line's MP3. It's made by OpenAI the first time, then served from storage. */
export function sceneLineAudioUrl(sceneId, lineId) {
  return `${API_BASE}/scenes/${sceneId}/lines/${lineId}/audio`;
}

/**
 * Writes a new scene for a request Kai made (when a saved scene already matched it) and
 * adds it to the conversation; resolves to { message_id, response, scene }.
 */
export function writeNewScene(conversationId, sceneRequest, learnerRequest) {
  return sendJson(`/conversations/${encodeURIComponent(conversationId)}/scenes`, {
    ...sceneRequest,
    request: learnerRequest,
  });
}

/** Starts practising a scene as one of its characters; resolves to { id, ... }. */
export function startRun(sceneId, myRole) {
  return sendJson("/practice-runs", { scene_id: sceneId, my_role: myRole });
}

/** Finishes a practice run, which counts towards the scene's practice_count. */
export function finishRun(runId, avgScore, activeSeconds) {
  return sendJson(
    `/practice-runs/${runId}`,
    { avg_score: avgScore, active_seconds: activeSeconds },
    "PATCH"
  );
}

// --- Practice time -------------------------------------------------------------------

function activityBody(seconds, mode, sceneId, conversationId) {
  return { seconds, mode, scene_id: sceneId ?? null, conversation_id: conversationId ?? null };
}

/**
 * Adds seconds of active practice to today, under the conversation (if there is one yet);
 * resolves to today's { date, seconds, goal_minutes }. mode is "free_talk" or "scene".
 */
export function sendActivity(seconds, mode, sceneId, conversationId) {
  return sendJson("/activity", activityBody(seconds, mode, sceneId, conversationId));
}

/** The same as sendActivity, for when the page is closing; returns whether it was queued. */
export function beaconActivity(seconds, mode, sceneId, conversationId) {
  const body = JSON.stringify(activityBody(seconds, mode, sceneId, conversationId));
  return navigator.sendBeacon?.(
    `${API_BASE}/activity`,
    new Blob([body], { type: "application/json" })
  );
}

/** Resolves to today's { date, seconds, goal_minutes }. */
export function getActivityToday() {
  return get("/activity/today");
}

/**
 * Minutes practised on each of the last `days` days (IST); resolves to
 * { goal_minutes, days: [{ date: "YYYY-MM-DD", minutes }] }, oldest first, ending today.
 */
export function getActivity(days) {
  return get(`/activity?days=${days}`);
}
