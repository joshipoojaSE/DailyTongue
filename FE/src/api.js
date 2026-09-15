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
 * { response, audio_base64, conversation_id, user_message_id, message_id }.
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

/**
 * Minutes talked with Kai on each of the last `days` days (IST); resolves to
 * { goal_minutes, days: [{ date: "YYYY-MM-DD", minutes }] }, oldest first, ending today.
 */
export async function getProgress(conversationId, days) {
  const res = await fetch(
    `${API_BASE}/conversations/${encodeURIComponent(conversationId)}/progress?days=${days}`
  );
  return parse(res);
}

/** URL of the MP3 for one of Kai's stored replies. */
export function messageAudioUrl(messageId) {
  return `${API_BASE}/messages/${messageId}/audio`;
}
