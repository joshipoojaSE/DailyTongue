# DailyTongue

**A voice-first English speaking coach.** You talk to an AI partner out loud. A second AI quietly corrects your English as you go. You can also rehearse scripted dialogues line by line and see how much you practise each day.

I built this as a full-stack demo: a **FastAPI** backend that coordinates three OpenAI models (speech-to-text, chat and text-to-speech), **Neon Postgres** for storage, and a **React (Vite)** frontend that handles microphone recording, browser speech recognition, line scoring and a hand-built SVG chart.

- **[BE/](BE/)**: FastAPI backend ([BE/README.md](BE/README.md))
- **[FE/](FE/)**: React frontend ([FE/README.md](FE/README.md))

---

## What it does

| Feature | What the learner sees | What happens underneath |
| ------- | --------------------- | ----------------------- |
| **Free Talk** | Tap the mic and speak, or type. You see your transcript, then hear Kai's spoken reply. | Two requests: `/transcribe` first, then `/respond`, so your words show up before the reply is ready. Recording stops by itself after 2 s of silence. |
| **Tutor feedback** | An **Ila · Tutor** note under each of your messages: the corrected sentence, each mistake explained, and a more natural way to say it, with 🔊 to hear both. | A separate tutor agent reads the whole conversation and returns **structured output** (Pydantic schema). It runs after Kai's reply, so it never slows that reply down. |
| **Scenes** | Ask Kai for "a dialogue between Maya and Arjun in a forest at night". Save it, then practise it playing either character. | Kai uses **tool calling** (`create_scene`), and a second prompt writes the scene as strict JSON. Requests are deduplicated with a `cache_key` hash. |
| **Scene practice** | Say your line. You get a score, with missed, extra and changed words marked. At the end you see your average score and weakest lines. | Recognition uses the browser's Web Speech API, and scoring is a **word-level edit distance** in the browser. Each line's audio is generated once and cached in Postgres, so **a replay costs no OpenAI calls**. |
| **Daily goal** | A ring in the header shows "X of 60 min today", with a "paused" state. | Time counts only while you're actively speaking, typing or listening. A heartbeat goes to the backend every 15 s, and totals are added up per IST day. |
| **Progress dashboard** | Total, daily average, goal-met days, best day, a bar chart of minutes per day and a day-by-day list, over 7, 30 or 90 days. | `GET /activity?days=N`. The chart is hand-written SVG (no chart library), resizes with the window and can be read with the keyboard. |
| **History** | Reload the page and the conversation is still there. Older messages load as you scroll up. Each message is labelled with who sent it, whether it was spoken or typed, and the time in IST (for example "You · spoken · 19:40"), with day dividers. | Cursor-based pagination (`?before=<id>&limit=30`). Kai's reply audio is stored, so old replies replay without new TTS calls. |
| **Mascot** | A small animated tongue that listens, thinks, talks, cheers or says "oops" depending on what's happening. Ila's version wears glasses. | An SVG component driven by a `mood` prop. While you record, its mouth opens with the live mic level. |

## The three agents

| Agent | Role | What it sees | Voice |
| ----- | ---- | ------------ | ----- |
| **Learner** | The user, chatting by voice or text | Their own conversation with Kai | — |
| **Kai** | Conversational partner. Writes scenes through its `create_scene` tool, and plays the other character in scene practice. | Only its conversation with the learner (the last 20 messages) | `alloy`. Scene characters get `verse` and `nova`. |
| **Ila** | A warm, 30-year-old English tutor who silently watches the conversation. She corrects the learner's latest message and suggests a rephrasing, but never speaks in the chat. | The whole conversation, both sides | `coral`, read slowly and clearly |

Kai never sees Ila's feedback, so the conversation stays natural. Ila stays out of scene practice, because there the learner is reading a script.

## Architecture

```
                         ┌──────────────────── Browser (React + Vite) ────────────────────┐
                         │  MediaRecorder + Web Audio (waveform, stop after silence)      │
                         │  Web Speech API (scene lines)   scene.js (line scoring)        │
                         │  usePracticeTimer (active time, heartbeat every 15 s)          │
                         └───────────────┬────────────────────────────────────────────────┘
                                         │  /api/*  (Vite dev proxy)
                         ┌───────────────▼──────────── FastAPI (BE/main.py) ──────────────┐
  POST /transcribe ─────►│ gpt-4o-mini-transcribe                                          │
  POST /respond ────────►│ Kai: gpt-4.1-mini + create_scene tool ──► gpt-4o-mini-tts       │
  POST /…/feedback ─────►│ Ila: gpt-4.1-mini, structured output (Pydantic)                 │
  GET  /scenes/…/audio ─►│ TTS once per line, then served from Postgres                    │
  POST /activity ───────►│ activity.py: split seconds by IST day, add to practice_time     │
                         └───────────────┬────────────────────────────────────────────────┘
                                         │  pg8000 (pure Python) + db.py's own pool
                                  ┌──────▼──────┐
                                  │ Neon Postgres │  messages · feedback · scenes · scene_lines
                                  └─────────────┘  practice_runs · practice_time
```

A Free Talk turn:

```
Mic ──► FE ──POST /transcribe──► BE ──► gpt-4o-mini-transcribe ──► { transcript }   (shown right away)
        FE ──POST /respond─────► BE ──► gpt-4.1-mini ──► gpt-4o-mini-tts ──► { response, audio_base64 }
        FE ──POST /conversations/{id}/feedback──► BE ──► Ila ──► { corrected, mistakes, rephrased }
```

## Engineering decisions worth discussing

- **Latency.** Transcription and reply are separate requests, so the learner sees their own words straight away. Ila's feedback is fetched only after Kai's reply arrives, so the tutor never makes the conversation wait. (`POST /chat` does all three steps in one request, for clients that don't need this.)
- **OpenAI cost.**
  - Scene lines are voiced once and cached as MP3 in Postgres. On the first run, lines are generated in the background for *both* roles, so switching roles costs nothing.
  - Line scoring and speech recognition run in the browser.
  - Asking for the same scene again is caught by a sha256 `cache_key` over the normalised situation, topic and characters (filler words removed, character order ignored), and Kai offers the saved one.
  - Each tutor sentence's audio is fetched once and reused.
  - Every OpenAI call is logged (`openai call #12: tts (nova): ...`), so you can check that a replay makes zero calls.
  - `SCENE_TTS_PROVIDER=browser` makes scene practice entirely free.
- **Reliable model output.** Kai's tool uses `strict: True` JSON Schema. The scene writer and the tutor use `chat.completions.parse` with Pydantic models. Scenes are also validated on the server (exactly two distinct characters, 4–60 lines, every speaker is one of the two characters).
- **Fair scoring.** `compareLines` computes word-level Levenshtein distance and backtracks it into `same / missed / extra / changed` operations. Before comparing, it folds contractions together ("I am" = "I'm") and turns digits 0–20 into words ("3" = "three"), so speech-recognition quirks don't count against the learner.
- **Honest practice time.** The timer counts seconds only while the tab is visible and the learner is in Free Talk or a scene. It keeps them only if the learner spoke, typed or listened to Kai within the last 90 s, so leaving the tab open doesn't count. If a heartbeat crosses midnight IST, the backend splits it between the two days. Each heartbeat is capped at 120 s, which lets a few failed ones catch up.
- **Database on Windows and serverless Postgres.**
  - psycopg's binary DLL is blocked by Windows Smart App Control, so I switched to **pg8000** (pure Python) and wrote a small connection pool ([BE/db.py](BE/db.py)).
  - Neon drops idle connections, so the pool health-checks each connection before reusing it, and retires connections after 120 s idle or 600 s total.
  - Tables are created or upgraded on startup (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), so no migration step is needed.
- **Testable core.** Scene validation, `cache_key` and the IST day-splitting live in modules that use neither the database nor OpenAI ([BE/scenes.py](BE/scenes.py), [BE/activity.py](BE/activity.py)), and are covered by pytest. The dialogue parser and line scorer are covered by Vitest.

## Tech stack

| Layer | Tools |
| ----- | ----- |
| Backend | Python 3.10+, FastAPI, Pydantic, Uvicorn, OpenAI Python SDK, pg8000, python-dotenv |
| AI models | `gpt-4o-mini-transcribe` (STT), `gpt-4.1-mini` (Kai, scene writer, Ila), `gpt-4o-mini-tts` (voices) |
| Database | Neon (serverless Postgres) |
| Frontend | React 18, Vite 6, plain CSS, MediaRecorder, Web Audio API, Web Speech API, `speechSynthesis` |
| Tests | pytest (backend), Vitest (frontend) |

## Project structure

```
demo/
├── README.md               ← you are here
├── BE/                     FastAPI backend
│   ├── main.py             app, agents and prompts, all endpoints, table setup
│   ├── scenes.py           scene models, validation, cache_key, voices (no DB or OpenAI)
│   ├── activity.py         practice-time heartbeats, IST day splitting
│   ├── db.py               pg8000 connection pool tuned for Neon
│   ├── tests/              pytest: activity and scenes
│   └── requirements*.txt
└── FE/                     React (Vite) frontend
    └── src/
        ├── App.jsx         Free Talk chat, header, switching between views
        ├── Dashboard.jsx   progress dashboard and SVG chart
        ├── SceneLibrary.jsx · SaveScene.jsx · ScenePractice.jsx
        ├── scene.js        dialogue parser and line scoring (+ scene.test.js)
        ├── useRecorder.js · useSpeechInput.js · usePracticeTimer.js
        ├── Tongue.jsx      mascot
        ├── common.jsx      shared UI (tutor note, 🔊 button, icons)
        └── api.js          one function per backend endpoint
```

## Running it locally

**Prerequisites:** Python 3.10+, Node.js 18+, an OpenAI API key and a Neon (or any Postgres) database.

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

Start the API on http://127.0.0.1:8000. Tables are created on first start.

```powershell
.venv\Scripts\python.exe -m uvicorn main:app --reload
```

If you see `Fatal error in launcher: Unable to create process using '...python.exe'`, the venv was moved after it was created. The command above (`python -m uvicorn`) avoids that launcher. You can also rebuild the venv: `rm -r -force .venv`, then run the setup again.

### 2. Frontend

In a second terminal:

```bash
cd FE
npm install
npm run dev
```

Open http://localhost:5173 in **Chrome or Edge** (scene practice uses their speech recognition; in other browsers you type your lines instead). Tap the mic and start speaking.

In development, Vite proxies `/api/*` to the backend, so you don't need to set up CORS.

### Try this in a demo

1. Say *"Hi Kai, yesterday I go to market and buy some vegetable."* Watch Ila's note correct it, then tap 🔊.
2. Say *"Write a dialogue between Maya and Arjun in a forest at night, 6 lines each."* Tap **Save as scene**.
3. Open **My Scenes**, choose **Practice as Maya**, and say your lines. Try **Hide line** to say them from memory.
4. Practise it again, and check the backend console: no new `openai call #…` lines.
5. Open the goal ring in the header to see the progress dashboard.

## API

Interactive docs are at http://127.0.0.1:8000/docs while the server is running.

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| POST | `/transcribe` | multipart form, `audio` file | `{ transcript }` |
| POST | `/respond` | JSON `{ messages: [{ role, content }], conversation_id?, input? }` (`"spoken"` or `"typed"`) | `{ response, audio_base64, conversation_id, user_message_id, message_id, scene?, existing_scene?, scene_request? }` |
| POST | `/chat` | multipart form, `audio` file, optional `conversation_id` | `{ transcript, response, audio_base64, conversation_id, user_message_id, message_id, feedback }` |
| POST | `/conversations/{id}/feedback` | JSON `{ messages, message_id? }` | `{ id, message, corrected, mistakes: [{ original, correction, explanation }], rephrased, created_at }` |
| GET | `/conversations/{id}/feedback` | — | All feedback for the conversation, oldest first |
| GET | `/conversations/{id}/messages` | query `before`? (message id), `limit`? (1–100, default 30) | `{ messages: [{ id, role, content, input, has_audio, feedback, scene, created_at }], has_more }` |
| GET | `/messages/{id}/audio` | — | MP3 of one of Kai's stored replies |
| POST | `/speak` | JSON `{ text }` (up to 1000 characters) | `{ audio_base64 }` in Ila's voice |
| GET | `/config` | — | `{ scene_tts_provider, offscript_threshold, goal_minutes }` |
| POST | `/conversations/{id}/scenes` | JSON `{ situation, topic, characters, line_count, request? }` | Writes a new scene even though a saved one matched: `{ message_id, response, scene }` |
| POST | `/scenes` | JSON `{ title, characters: [a, b], lines: [{ speaker, text }], situation?, topic?, source_message_id? }` | The saved scene with its lines |
| GET | `/scenes` | — | `[{ id, title, situation, topic, characters, line_count, practice_count, last_practiced_at, source_message_id, created_at }]` |
| GET | `/scenes/{id}` | — | The scene with `lines: [{ id, line_no, speaker, text, voice, has_audio }]` |
| PATCH | `/scenes/{id}` | JSON `{ title }` | The renamed scene |
| DELETE | `/scenes/{id}` | — | `{ id }`. Also deletes its lines, their audio and its practice runs |
| GET | `/scenes/{id}/lines/{line_id}/audio` | — | MP3 of the line, made on the first request and stored |
| POST | `/practice-runs` | JSON `{ scene_id, my_role }` | `{ id, scene_id, my_role, started_at, ended_at, avg_score, active_seconds }` |
| PATCH | `/practice-runs/{id}` | JSON `{ avg_score, active_seconds }` | Finishes the run and counts it in the scene's `practice_count` |
| POST | `/activity` | JSON `{ seconds (1–120), mode: "free_talk" \| "scene", scene_id?, conversation_id? }` | Today's `{ date, seconds, goal_minutes }` |
| GET | `/activity/today` | — | Today's `{ date, seconds, goal_minutes }` |
| GET | `/activity` | query `days`? (1–366, default 7) | `{ goal_minutes, days: [{ date, minutes }] }`, oldest first |

Omit `conversation_id` to start a new conversation, and send the returned one on later turns. Audio is returned as base64 MP3. Uploads can be WAV, MP3, M4A or WEBM.

## Configuration

| Variable | Where | Purpose |
| -------- | ----- | ------- |
| `OPENAI_API_KEY` | `BE/.env` | OpenAI API key (required) |
| `DATABASE_URL` | `BE/.env` | Postgres connection string (required) |
| `SCENE_TTS_PROVIDER` | `BE/.env` | How scene lines are voiced: `openai_cached` (default: made once per line, then reused) or `browser` (`speechSynthesis`, free) |
| `SCENE_OFFSCRIPT_THRESHOLD` | `BE/.env` | Lines that score below this are marked off-script (default `0.7`) |
| `SCENE_VOICE_A`, `SCENE_VOICE_B` | `BE/.env` | OpenAI voices for a scene's two characters (default `verse`, `nova`) |
| `VITE_API_TARGET` | FE (dev) | Backend URL for the dev proxy (default `http://127.0.0.1:8000`) |
| `VITE_API_BASE` | FE (build) | API URL for a production build hosted separately from the backend |

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

- **Backend (pytest):** splitting heartbeats at midnight IST and adding them up per day; scene validation; `cache_key` normalisation (case, punctuation, filler words, character order); voice assignment.
- **Frontend (Vitest):** parsing `**Name:** line` dialogues out of Kai's messages; title suggestions; line scoring, including contractions, small numbers and each kind of edit.

## Known limitations

These were deliberate scope choices for a demo:

- **One user, no accounts.** Scenes and daily totals are shared by everyone using the same backend. The conversation id lives in `localStorage`.
- **CORS isn't configured.** In development the Vite proxy handles it. Serving the frontend from another origin requires adding CORS middleware.
- **Speech recognition in scene practice needs Chrome or Edge.** Other browsers fall back to typing.
- **"Today" is fixed to India Standard Time (IST)**, the learners' time zone.
