# DailyTongue

A minimal voice assistant: speak into your microphone, see your words transcribed, and hear the agent reply.

- **[BE/](BE/)** — FastAPI backend that transcribes audio, generates a reply, and turns that reply into speech with the OpenAI API.
- **[FE/](FE/)** — React (Vite) frontend that records from the microphone and plays the agent's replies.

## How it works

```
Microphone ──► FE ──POST /transcribe──► BE ──► gpt-4o-mini-transcribe ──► transcript
                   ◄───── { transcript } ─────┘
               FE ──POST /respond───► BE ──► gpt-4.1-mini ──► gpt-4o-mini-tts
                   ◄── { response, audio_base64 } ──┘
```

The frontend makes two requests so it can show your transcript before the reply is ready. The backend also offers `POST /chat`, which does both steps in one request.

### Agents

| Agent | Role | Sees |
| ----- | ---- | ---- |
| **User** | The learner, chatting normally | Their own conversation with Kai |
| **Ila** (tutor) | A warm 30-year-old English tutor who silently observes and coaches. Corrects every message the learner sends, suggests a more natural way to rephrase it, and stores the feedback in the database | The full conversation between the learner and Kai (both sides) |
| **Kai** | Conversational partner with general knowledge | Only its own conversation with the learner |

Once Kai's reply arrives, the frontend sends the conversation, including that reply, to `POST /conversations/{conversation_id}/feedback`. Ila corrects the learner's latest message, suggests another way to say it, and saves the feedback in SQLite, and the frontend shows it in a small **Ila · Tutor** note under that message. A 🔊 button next to the corrected and rephrased sentences reads them aloud in Ila's voice through `POST /speak`, so the learner can hear how they sound. The tutor never slows down Kai's reply or speaks in the chat, and Kai never sees its feedback. `GET /conversations/{conversation_id}/feedback` lists all feedback for a conversation.

### History

`/respond` and `/chat` save every message (and the audio of Kai's replies) in SQLite. The frontend remembers the conversation id in `localStorage`, so after a reload it shows the latest messages from `GET /conversations/{conversation_id}/messages`, and loads older pages (with their tutor notes) as you scroll up.

Each message is labelled with who sent it, whether it was spoken or typed, and its time in IST (for example "You · spoken · 19:40"), and a "Today", "Yesterday" or "Tue 8 Sept" divider marks each new day.

## Prerequisites

- Python 3.10+
- Node.js 18+
- An OpenAI API key

## Quick start

### 1. Backend

```bash
cd BE
python -m venv .venv
.venv\Scripts\activate        # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

Create `BE/.env`:

```env
OPENAI_API_KEY=your_api_key
```

Start the API on http://127.0.0.1:8000:

```bash
uvicorn main:app --reload
```

### 2. Frontend

In a second terminal:

```bash
cd FE
npm install
npm run dev
```

Open http://localhost:5173, tap the microphone, and start speaking.

During development, Vite proxies `/api/*` to the backend, so you don't need to set up CORS.

## API

| Method | Path          | Body                        | Returns                                    |
| ------ | ------------- | --------------------------- | ------------------------------------------ |
| POST   | `/transcribe` | multipart form, `audio` file | `{ transcript }`                           |
| POST   | `/respond`    | JSON `{ "messages": [{ "role", "content" }], "conversation_id"?, "input"? }` (`"spoken"` or `"typed"`) | `{ response, audio_base64, conversation_id, user_message_id, message_id }` |
| POST   | `/chat`       | multipart form, `audio` file, optional `conversation_id` | `{ transcript, response, audio_base64, conversation_id, user_message_id, message_id, feedback }` |
| POST   | `/conversations/{conversation_id}/feedback` | JSON `{ "messages": [{ "role", "content" }], "message_id"? }` | `{ id, message, corrected, mistakes: [{ original, correction, explanation }], rephrased, created_at }` |
| GET    | `/conversations/{conversation_id}/feedback` | — | A list of the feedback objects above, oldest first |
| GET    | `/conversations/{conversation_id}/messages` | query `before`? (message id), `limit`? (1–100, default 30) | `{ messages: [{ id, role, content, input, has_audio, feedback, created_at }], has_more }`, oldest first |
| GET    | `/messages/{message_id}/audio` | — | MP3 of one of Kai's stored replies |
| POST   | `/speak`      | JSON `{ "text" }` (up to 1000 characters) | `{ audio_base64 }` of the text read slowly and clearly |

Omit `conversation_id` to start a new conversation; send back the returned one on later turns. `audio_base64` holds MP3 audio. The API accepts common audio formats such as WAV, MP3, M4A, and WEBM. Interactive docs are at http://127.0.0.1:8000/docs while the server is running.

## Configuration

| Variable          | Where      | Purpose                                                               |
| ----------------- | ---------- | --------------------------------------------------------------------- |
| `OPENAI_API_KEY`  | `BE/.env`  | OpenAI API key (required)                                             |
| `DATABASE_PATH`   | `BE/.env`  | SQLite file for messages and tutor feedback (default `BE/dailytongue.db`) |
| `VITE_API_TARGET` | FE (dev)   | Backend URL for the dev proxy (default `http://127.0.0.1:8000`)        |
| `VITE_API_BASE`   | FE (build) | API URL for a production build hosted separately from the backend    |

If you serve the frontend build from a different origin than the API, add CORS middleware to the backend.

See [BE/README.md](BE/README.md) and [FE/README.md](FE/README.md) for more details.
