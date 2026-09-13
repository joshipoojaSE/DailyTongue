const API_BASE = import.meta.env.VITE_API_BASE || "/api";

async function request(path, options) {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", ...options });

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
 * latest message); resolves to { response, audio_base64 }.
 */
export function getReply(messages) {
  return request("/respond", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}
