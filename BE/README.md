# DailyTongue API

A minimal FastAPI DailyTongue. Upload an audio file and receive its transcript and assistant response.

## Setup

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Common audio formats such as WAV, MP3, M4A, and WEBM are supported.

Create a `.env` file:

```env
OPENAI_API_KEY=your_api_key
DATABASE_URL=postgresql://user:password@host.neon.tech/DailyTongue?sslmode=require
```

`DATABASE_URL` is the Neon Postgres connection string. The tables are created on
startup if they don't exist.

## Run

```powershell
.venv\Scripts\activate
python -m uvicorn main:app --reload
```

`python -m` makes sure the venv's uvicorn runs; a bare `uvicorn` can silently pick up a
global install instead.

Postgres is reached through pg8000, a pure-Python driver. psycopg's binary build ships an
unsigned DLL that Windows Smart App Control blocks
(`DLL load failed ... An Application Control policy has blocked this file`).

`Fatal error in launcher: Unable to create process using '...python.exe'` means the venv was
moved or renamed after it was created, so the `.exe` launchers in `.venv\Scripts\` point at a
python that is no longer there. Run the module directly,
`.venv\Scripts\python.exe -m uvicorn main:app --reload` (same for pip:
`.venv\Scripts\python.exe -m pip ...`), or rebuild the venv:

```powershell
rm -r -force .venv
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Requests

All-in-one (transcript, reply text and reply audio in one response):

```bash
curl -X POST http://127.0.0.1:8000/chat ^
  -F "audio=@recording.wav"
```

Two-step, so a client can show the transcript before the reply is ready:

```bash
# 1. Audio -> { "transcript": "..." }
curl -X POST http://127.0.0.1:8000/transcribe ^
  -F "audio=@recording.wav"

# 2. Conversation -> { "response": "...", "audio_base64": "..." }
curl -X POST http://127.0.0.1:8000/respond ^
  -H "Content-Type: application/json" ^
  -d "{\"messages\": [{\"role\": \"user\", \"content\": \"Hello, how are you?\"}]}"
```

`messages` is the conversation so far, oldest first, and must end with a `user` message.
The server sends only the last 20 messages to the model.

The response also includes a `conversation_id`. Send it back as `"conversation_id"` on later
turns to keep the conversation together. Optionally send `"input": "spoken"` or `"typed"` to
record how the learner entered their message. The learner's message and Kai's reply (with its
audio) are saved; their ids come back as `user_message_id` and `message_id`.

## History

Page back through a conversation, newest page first. Each page is oldest first, with the tutor
feedback for each learner message:

```bash
# The latest 30 messages
curl http://127.0.0.1:8000/conversations/<conversation_id>/messages

# The 30 before message 120
curl "http://127.0.0.1:8000/conversations/<conversation_id>/messages?before=120&limit=30"
```

```json
{
  "messages": [
    { "id": 118, "role": "user", "content": "yesterday I go to market", "input": "spoken", "has_audio": false, "feedback": { "...": "..." }, "created_at": "2026-09-13 10:12:01" },
    { "id": 119, "role": "assistant", "content": "Nice! What did you buy?", "input": null, "has_audio": true, "feedback": null, "created_at": "2026-09-13 10:12:03" }
  ],
  "has_more": true
}
```

`created_at` is UTC. `input` is `"spoken"` or `"typed"` for learner messages (`/chat` always
records `"spoken"`), and `null` for Kai or when it wasn't sent.

`GET /messages/<message_id>/audio` returns the MP3 of a stored reply.

## Daily goal

Learners aim to practise for 60 minutes a day (`DAILY_GOAL_MINUTES`). Days run from
midnight to midnight IST. Practice time is measured by the frontend, not by API requests:
it counts seconds while the learner is in Free Talk or scene practice, the tab is visible,
and they spoke or typed in the last 90 seconds. Every 15 seconds it sends them as a
heartbeat with the conversation id, which [activity.py](activity.py) adds to that
conversation's row for the day in `practice_time` (a heartbeat that crosses midnight is split
between the two days). A day's total is the sum over all conversations:

```bash
curl -X POST http://127.0.0.1:8000/activity ^
  -H "Content-Type: application/json" ^
  -d "{\"seconds\": 15, \"mode\": \"scene\", \"scene_id\": 3}"
# -> { "date": "2026-10-19", "seconds": 1815, "goal_minutes": 60 }

curl http://127.0.0.1:8000/activity/today
```

Get the minutes for each of the last `days` days (1–366, default 7), oldest first, ending today:

```bash
curl "http://127.0.0.1:8000/activity?days=7"
```

```json
{
  "goal_minutes": 60,
  "days": [
    { "date": "2026-09-09", "minutes": 0 },
    { "date": "2026-09-10", "minutes": 72 },
    "...",
    { "date": "2026-09-15", "minutes": 42 }
  ]
}
```

## Scenes

A scene is a saved two-character dialogue the learner practises line by line
([scenes.py](scenes.py) has the validation and `cache_key`). Tables: `scenes`, `scene_lines`
(each line's MP3 is stored in `audio` once made), `practice_runs`, plus a `scene` column on
`messages` for Kai's messages that wrote one. They're created on startup like the rest.

Kai calls its `create_scene` tool when asked for a dialogue. If a saved scene has the same
`cache_key` (sha256 of the normalised situation, topic and characters), `/respond` returns it
as `existing_scene` without writing anything. Otherwise a second request writes the scene as
strict JSON, returned as `scene`.

```bash
# Save a dialogue (no OpenAI request)
curl -X POST http://127.0.0.1:8000/scenes -H "Content-Type: application/json" -d @scene.json

# A line's audio: made with OpenAI on the first request, served from the database after
curl -o line.mp3 http://127.0.0.1:8000/scenes/1/lines/2/audio

# Start and finish a run; finishing counts it in the scene's practice_count
curl -X POST http://127.0.0.1:8000/practice-runs -H "Content-Type: application/json" -d "{\"scene_id\": 1, \"my_role\": \"Maya\"}"
curl -X PATCH http://127.0.0.1:8000/practice-runs/1 -H "Content-Type: application/json" -d "{\"avg_score\": 0.86, \"active_seconds\": 140}"

```

Optional settings in `.env`:

```env
SCENE_TTS_PROVIDER=openai_cached   # or browser: the frontend uses speechSynthesis instead
SCENE_OFFSCRIPT_THRESHOLD=0.7  # lines below are marked off-script
SCENE_VOICE_A=verse                # the scene's first character
SCENE_VOICE_B=nova                 # the second
```

Every OpenAI request is logged to the console as `openai call #N: ...`, so you can check
that replaying a scene makes none.

## Tests

```powershell
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest
```

## Tutor feedback

Ila, a silent tutor agent (a warm 30-year-old English tutor), reads the whole conversation
(learner and Kai), corrects the
learner's latest message, and suggests a more natural way to rephrase it (even when it has
no mistakes). Kai never sees its feedback. Call it after `/respond` returns,
passing the conversation including Kai's reply, and optionally the learner message's
`message_id` from `/respond` so the feedback appears with it in history:

```bash
curl -X POST http://127.0.0.1:8000/conversations/<conversation_id>/feedback ^
  -H "Content-Type: application/json" ^
  -d "{\"messages\": [{\"role\": \"user\", \"content\": \"yesterday I go to market\"}, {\"role\": \"assistant\", \"content\": \"Nice! What did you buy?\"}]}"
```

To hear a tutor sentence, send it to `/speak`. It returns `{ "audio_base64": "..." }` (MP3),
read slowly and clearly in Ila's voice:

```bash
curl -X POST http://127.0.0.1:8000/speak ^
  -H "Content-Type: application/json" ^
  -d "{\"text\": \"Yesterday I went to the market.\"}"
```

`/chat` runs the tutor itself and includes the result as `feedback`, which is `null` if the
tutor failed.

Messages and feedback are stored in Neon Postgres, in the `messages` and `feedback` tables
of the database named in `DATABASE_URL`.
To list everything for a conversation:

```bash
curl http://127.0.0.1:8000/conversations/<conversation_id>/feedback
```

```json
[
  {
    "id": 1,
    "message": "yesterday I go to market",
    "corrected": "Yesterday I went to the market.",
    "mistakes": [
      {
        "original": "go",
        "correction": "went",
        "explanation": "Use the past tense for something that already happened."
      },
      {
        "original": "to market",
        "correction": "to the market",
        "explanation": "Use \"the\" before a specific place like the market."
      }
    ],
    "rephrased": "I popped over to the market yesterday.",
    "created_at": "2026-09-13 10:12:04"
  }
]
```
