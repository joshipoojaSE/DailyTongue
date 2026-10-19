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

Learners aim to talk with Kai for 60 minutes a day (`DAILY_GOAL_MINUTES`). Days run from
midnight to midnight IST. A day's time is the time between its consecutive messages in the
conversation; gaps longer than 5 minutes (`IDLE_GAP`) count as a break and are skipped.
Each message adds its gap to that day's total in the `practice_time` table as it is saved,
so progress is read from the database rather than recomputed from every message.

Get the minutes for each of the last `days` days (1–366, default 7), oldest first, ending today:

```bash
curl "http://127.0.0.1:8000/conversations/<conversation_id>/progress?days=7"
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
