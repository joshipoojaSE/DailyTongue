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
| **Ila** (tutor) | A warm 30-year-old English tutor who silently observes and coaches. Corrects every message the learner sends, suggests a more natural way to rephrase it, and stores the feedback in the database. She isn't part of scene practice | The full conversation between the learner and Kai (both sides) |
| **Kai** | Conversational partner with general knowledge. Writes scenes (two-character dialogues) when asked, and plays the other character in scene practice | Only its own conversation with the learner |

Once Kai's reply arrives, the frontend sends the conversation, including that reply, to `POST /conversations/{conversation_id}/feedback`. Ila corrects the learner's latest message, suggests another way to say it, and saves the feedback in Neon Postgres, and the frontend shows it in a small **Ila · Tutor** note under that message. A 🔊 button next to the corrected and rephrased sentences reads them aloud in Ila's voice through `POST /speak`, so the learner can hear how they sound. The tutor never slows down Kai's reply or speaks in the chat, and Kai never sees its feedback. `GET /conversations/{conversation_id}/feedback` lists all feedback for a conversation.

### History

`/respond` and `/chat` save every message (and the audio of Kai's replies) in Neon Postgres. The frontend remembers the conversation id in `localStorage`, so after a reload it shows the latest messages from `GET /conversations/{conversation_id}/messages`, and loads older pages (with their tutor notes) as you scroll up.

Each message is labelled with who sent it, whether it was spoken or typed, and its time in IST (for example "You · spoken · 19:40"), and a "Today", "Yesterday" or "Tue 8 Sept" divider marks each new day.

### Scenes

Ask Kai for a dialogue between two characters ("a dialogue between Maya and Arjun in a forest at night, 8 lines each") and you can save it and practise it as often as you like, playing either character, without calling OpenAI each time.

- **Writing a scene.** Kai has a `create_scene` tool. When you ask for a dialogue it calls the tool with the situation, topic and characters. The backend checks for a saved scene with the same `cache_key` (sha256 of the normalised situation, topic and characters). If there is one, Kai offers to open it instead of writing a new one. Otherwise a dedicated prompt writes the scene as strict JSON (`title`, `situation`, `topic`, `characters`, `lines`), and the chat shows it as `**Name:** line` text.
- **Save as scene.** Any message from Kai with `**Name:** line` lines from exactly two speakers, and at least four of them, gets a **Save as scene** button. That includes dialogues Kai wrote before scenes existed. The message is parsed in the browser, so saving makes no OpenAI request. You can edit the title first; it starts as your request (or the first line).
- **My Scenes** (header button) lists your scenes with their characters, line count and practice history, with **Practice as …**, Rename and Delete.
- **Scene practice.** You play one character and Kai plays the other.
  - Kai says its lines.
  - Your next line shows above the input. **Hide line** lets you say it from memory, and **Hear it** plays it.
  - You speak your line (the browser's Web Speech API, in Chrome and Edge) or type it. It's compared with the script in the browser, word by word, with a score and the missed, extra and changed words marked.
  - At the end you get your average score, your weakest lines, **Practice again** and **Switch role**.
- **Ila** stays out of scene practice. A line that scores below `SCENE_OFFSCRIPT_THRESHOLD` (0.7) is marked off-script and shows the script line.
- **Kai's voice in scenes:**
  - With `SCENE_TTS_PROVIDER=openai_cached`, each line's audio is made once, in its character's own voice, the first time it's needed. It's stored in Postgres and reused from then on. The first run also makes the audio for your own character's lines in the background, so switching roles later needs nothing new.
  - With `browser`, the browser's `speechSynthesis` reads the lines, so practice is free from the start.

After the first run of a scene, practising it again in either role makes **no OpenAI requests**. The backend logs every OpenAI call (`openai call #12: tts (nova): ...`) to its console, so you can check.

### Practice time

The header's "X of 60 min today" is your own active practice time, measured in the browser, not time spent waiting for OpenAI. It counts while you're in Free Talk or scene practice, the tab is visible, and you've spoken or typed in the last 90 seconds. Otherwise it shows "paused". Every 15 seconds the browser sends the counted seconds to `POST /activity`, which adds them to that IST day in the `practice_time` table, under your conversation. The header and the dashboard add up each day across conversations, so the total survives a reload and includes your earlier history.

## Prerequisites

- Python 3.10+
- Node.js 18+
- An OpenAI API key

## Quick start

### 1. Backend

```powershell
cd BE
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

On macOS/Linux, that last line is `.venv/bin/python -m pip install -r requirements.txt`.

Create `BE/.env`:

```env
OPENAI_API_KEY=your_api_key
DATABASE_URL=postgresql://user:password@host.neon.tech/DailyTongue?sslmode=require
```

The backend creates its tables in that Neon database on startup if they don't exist, and adds any new ones (or columns) after an upgrade. There is no separate migration step: restart the backend.

Start the API on http://127.0.0.1:8000:

```powershell
.venv\Scripts\activate        # macOS/Linux: source .venv/bin/activate
uvicorn main:app --reload
```

If `uvicorn` fails with `Fatal error in launcher: Unable to create process using '...python.exe'`,
the venv was moved or renamed after it was created — the `.exe` launchers in `.venv\Scripts\`
still point at the old path. Run the module directly instead:

```powershell
.venv\Scripts\python.exe -m uvicorn main:app --reload
```

or rebuild the venv:

```powershell
rm -r -force .venv
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
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
| GET    | `/config`     | — | `{ scene_tts_provider, offscript_threshold, goal_minutes }` |
| POST   | `/conversations/{conversation_id}/scenes` | JSON `{ situation, topic, characters, line_count, request? }` | Writes a new scene even though a saved one matched: `{ message_id, response, scene }` |
| POST   | `/scenes`     | JSON `{ title, characters: [a, b], lines: [{ speaker, text }], situation?, topic?, source_message_id? }` | The saved scene with its lines |
| GET    | `/scenes`     | — | `[{ id, title, situation, topic, characters, line_count, practice_count, last_practiced_at, source_message_id, created_at }]` |
| GET    | `/scenes/{id}` | — | The scene with `lines: [{ id, line_no, speaker, text, voice, has_audio }]` |
| PATCH  | `/scenes/{id}` | JSON `{ title }` | The renamed scene |
| DELETE | `/scenes/{id}` | — | `{ id }`; also deletes its lines, their audio and its practice runs |
| GET    | `/scenes/{id}/lines/{line_id}/audio` | — | MP3 of the line, made on the first request and stored |
| POST   | `/practice-runs` | JSON `{ scene_id, my_role }` | `{ id, scene_id, my_role, started_at, ended_at, avg_score, active_seconds }` |
| PATCH  | `/practice-runs/{id}` | JSON `{ avg_score, active_seconds }` | Finishes the run and counts it in the scene's `practice_count` |
| POST   | `/activity`   | JSON `{ seconds (1–120), mode: "free_talk" \| "scene", scene_id? }` | Today's `{ date, seconds, goal_minutes }` |
| GET    | `/activity/today` | — | Today's `{ date, seconds, goal_minutes }` |
| GET    | `/activity`   | query `days`? (1–366, default 7) | `{ goal_minutes, days: [{ date, minutes }] }`, oldest first |

`/respond` also returns `scene` when Kai wrote a scene, or `existing_scene` (`{ id, title }`) and `scene_request` when a saved scene matched the request. `GET /conversations/{id}/messages` includes each message's `scene`.

Omit `conversation_id` to start a new conversation; send back the returned one on later turns. `audio_base64` holds MP3 audio. The API accepts common audio formats such as WAV, MP3, M4A, and WEBM. Interactive docs are at http://127.0.0.1:8000/docs while the server is running.

## Configuration

| Variable          | Where      | Purpose                                                               |
| ----------------- | ---------- | --------------------------------------------------------------------- |
| `OPENAI_API_KEY`  | `BE/.env`  | OpenAI API key (required)                                             |
| `DATABASE_URL`    | `BE/.env`  | Neon Postgres connection string for messages and tutor feedback (required) |
| `SCENE_TTS_PROVIDER` | `BE/.env` | How Kai's lines are voiced in scene practice: `openai_cached` (default; made once per line, then reused) or `browser` (the browser's speech, free) |
| `SCENE_OFFSCRIPT_THRESHOLD` | `BE/.env` | In scene practice, a line that scores below this is marked off-script (default `0.7`) |
| `SCENE_VOICE_A`, `SCENE_VOICE_B` | `BE/.env` | OpenAI voices for a scene's first and second character (default `verse` and `nova`) |
| `VITE_API_TARGET` | FE (dev)   | Backend URL for the dev proxy (default `http://127.0.0.1:8000`)        |
| `VITE_API_BASE`   | FE (build) | API URL for a production build hosted separately from the backend    |

If you serve the frontend build from a different origin than the API, add CORS middleware to the backend.

## Tests

```powershell
cd BE
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest
```

```bash
cd FE
npm test
```

The backend tests cover adding up practice time by IST day, scene validation and the scene `cache_key`. The frontend tests cover the dialogue parser and the line comparison.

See [BE/README.md](BE/README.md) and [FE/README.md](FE/README.md) for more details.
