# DailyTongue API (backend)

The FastAPI backend for DailyTongue. It coordinates two AI agents (Kai, the conversational partner, and Ila, the tutor) across OpenAI speech-to-text, chat and text-to-speech. It stores conversations, feedback, scenes and practice time in Neon Postgres, and caches generated audio so repeated practice is free.

See the [root README](../README.md) for the product overview and the [frontend README](../FE/README.md) for the UI.

## Modules

| File | Responsibility |
| ---- | -------------- |
| [main.py](main.py) | The FastAPI app: agent prompts, Kai's `create_scene` tool, Pydantic request and response models, every endpoint, table creation on startup, and the OpenAI call log |
| [scenes.py](scenes.py) | Scene models, `scene_problem` validation, `cache_key`, voice assignment, and turning a scene into chat text. **Uses neither the database nor OpenAI**, so it's unit-tested on its own. |
| [activity.py](activity.py) | Practice-time heartbeats: `split_by_day` (splits seconds at midnight IST) and `add_activity` (an upsert into `practice_time`) |
| [db.py](db.py) | A small connection pool on **pg8000** that health-checks connections and retires stale ones (Neon drops idle connections) |
| [tests/](tests/) | pytest suites for `activity.py` and `scenes.py` |

## How a request flows

**Free Talk turn (`POST /respond`)**

1. Kai (`gpt-4.1-mini`) gets the system prompt and the **last 20 messages** (`MAX_HISTORY_MESSAGES`), and has the `create_scene` tool available.
2. For a normal reply, the text is voiced with `gpt-4o-mini-tts` (voice `alloy`).
3. If Kai calls `create_scene` (because the learner asked for a dialogue):
   - The backend computes `cache_key(situation, topic, characters)`.
   - If a saved scene has the same key, it returns `existing_scene` and `scene_request`, with no second model call.
   - Otherwise a second `gpt-4.1-mini` call with `SCENE_PROMPT` writes the scene, parsed into the `GeneratedScene` Pydantic model. It's checked with `scene_problem` and returned as `scene`.
4. The learner's message and Kai's reply (with its MP3 and any scene JSON) are saved to `messages`.

**Tutor feedback (`POST /conversations/{id}/feedback`)**

Ila (`gpt-4.1-mini`) reads the whole conversation, labelled *Learner* and *Kai*, and returns structured output: `corrected`, `mistakes[{ original, correction, explanation }]` and `rephrased`. The frontend calls this after Kai's reply has arrived, so it never delays the conversation. The result is stored in `feedback`, linked to the learner's `message_id`.

**Scene line audio (`GET /scenes/{id}/lines/{line_id}/audio`)**

On the first request, the line is voiced in its character's voice (`SCENE_VOICE_A` or `SCENE_VOICE_B`) with acting instructions, and the MP3 is stored in `scene_lines.audio`. Every later request is served from Postgres.

## Data model

All tables are created on startup with `CREATE TABLE IF NOT EXISTS`, and new columns are added with `ADD COLUMN IF NOT EXISTS`, so upgrading just means restarting.

| Table | Holds | Key columns |
| ----- | ----- | ----------- |
| `messages` | Every learner and Kai message | `conversation_id`, `role`, `content`, `input` (`spoken`/`typed`), `audio` (Kai's MP3), `scene` (JSON) |
| `feedback` | Ila's notes | `conversation_id`, `message_id`, `corrected`, `mistakes` (JSON), `rephrased` |
| `scenes` | Saved dialogues | `title`, `situation`, `topic`, `char_a`, `char_b`, `cache_key` (unique), `practice_count`, `last_practiced_at` |
| `scene_lines` | The lines of each scene | `scene_id`, `line_no`, `speaker`, `text`, `voice`, `audio` (cached MP3) |
| `practice_runs` | One practice run of a scene | `scene_id`, `my_role`, `started_at`, `ended_at`, `avg_score`, `active_seconds` |
| `practice_time` | Seconds practised | primary key `(conversation_id, day)`, `seconds` |

## Design notes

- **Why pg8000.** psycopg's binary build ships an unsigned DLL that Windows Smart App Control blocks (`DLL load failed ... An Application Control policy has blocked this file`). pg8000 is pure Python. [db.py](db.py) adds what psycopg_pool would have provided: a bounded pool, commit on success and rollback on error, a `SELECT 1` check before reuse, and retiring connections after `max_idle=120 s` or `max_lifetime=600 s`, before Neon's proxy closes them.
- **Scene deduplication.** `normalise` lowercases the text and removes punctuation and filler words (`a, the, in, at, ...`). `cache_key` sorts the two character names. So "In the forest, at night" with Arjun & Maya hits the same scene as "forest at night" with Maya & Arjun.
- **Scene validation.** A scene must have exactly two different characters and 4–60 lines (`MIN_LINES`, `MAX_LINES`), every speaker must be one of the two characters, and no line may be empty. This applies both to scenes Kai writes and to dialogues the learner saves from chat.
- **Distinct voices.** Kai is `alloy`, Ila is `coral` (read slowly and clearly), and scene characters are `verse` and `nova`, so the learner can always tell who is speaking.
- **Every OpenAI call is logged** to the console as `openai call #N: <kind>`, so you can check that replaying a scene makes none.
- **Practice time is measured by the frontend**, not inferred from API traffic (see [Daily goal](#daily-goal)).

## Setup

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Create a `.env` file:

```env
OPENAI_API_KEY=your_api_key
DATABASE_URL=postgresql://user:password@host.neon.tech/DailyTongue?sslmode=require
```

Optional settings:

```env
SCENE_TTS_PROVIDER=openai_cached   # or browser: the frontend uses speechSynthesis instead
SCENE_OFFSCRIPT_THRESHOLD=0.7      # lines that score below this are marked off-script
SCENE_VOICE_A=verse                # the scene's first character
SCENE_VOICE_B=nova                 # the second
```

## Run

```powershell
.venv\Scripts\python.exe -m uvicorn main:app --reload
```

Interactive docs are at http://127.0.0.1:8000/docs.

`python -m` makes sure the venv's uvicorn runs; a bare `uvicorn` can silently pick up a global install instead.

`Fatal error in launcher: Unable to create process using '...python.exe'` means the venv was moved or renamed after it was created, so the `.exe` launchers in `.venv\Scripts\` point at a Python that is no longer there. Use `python -m` as above (and the same for pip), or rebuild the venv:

```powershell
rm -r -force .venv
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Tests

```powershell
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest
```

- `test_activity.py`: UTC to IST conversion; heartbeats split across midnight (and one ending exactly at midnight); adding heartbeats up per day; Free Talk and scene time sharing one total; practice before the first message (no conversation id yet) still counting.
- `test_scenes.py`: `scene_problem` rules; `cache_key` ignoring case, punctuation, filler words and character order, and differing for a different request; a separate voice for each character; the chat dialogue format.

## Examples

### Conversation

All in one request (transcript, reply text, reply audio and tutor feedback):

```bash
curl -X POST http://127.0.0.1:8000/chat ^
  -F "audio=@recording.wav"
```

In two steps, so a client can show the transcript before the reply is ready:

```bash
# 1. Audio -> { "transcript": "..." }
curl -X POST http://127.0.0.1:8000/transcribe ^
  -F "audio=@recording.wav"

# 2. Conversation -> { "response": "...", "audio_base64": "...", "conversation_id": "...", ... }
curl -X POST http://127.0.0.1:8000/respond ^
  -H "Content-Type: application/json" ^
  -d "{\"messages\": [{\"role\": \"user\", \"content\": \"Hello, how are you?\"}], \"input\": \"spoken\"}"
```

`messages` is the conversation so far, oldest first, and must end with a `user` message. Send the returned `conversation_id` on later turns to keep the conversation together. The ids of the saved messages come back as `user_message_id` and `message_id`. Uploads can be WAV, MP3, M4A or WEBM.

### History

Page back through a conversation. Each page is oldest first and includes the tutor feedback for each learner message:

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

`created_at` is in UTC. `input` is `"spoken"` or `"typed"` for learner messages (`/chat` always records `"spoken"`), and `null` for Kai's messages or when it wasn't sent. `GET /messages/<message_id>/audio` returns the MP3 of a stored reply.

### Tutor feedback

```bash
curl -X POST http://127.0.0.1:8000/conversations/<conversation_id>/feedback ^
  -H "Content-Type: application/json" ^
  -d "{\"messages\": [{\"role\": \"user\", \"content\": \"yesterday I go to market\"}, {\"role\": \"assistant\", \"content\": \"Nice! What did you buy?\"}]}"
```

Pass `"message_id"` (from `/respond`) as well, so the feedback appears with that message in history. `GET` on the same path lists all feedback for the conversation:

```json
[
  {
    "id": 1,
    "message": "yesterday I go to market",
    "corrected": "Yesterday I went to the market.",
    "mistakes": [
      { "original": "go", "correction": "went", "explanation": "Use the past tense for something that already happened." },
      { "original": "to market", "correction": "to the market", "explanation": "Use \"the\" before a specific place like the market." }
    ],
    "rephrased": "I popped over to the market yesterday.",
    "created_at": "2026-09-13 10:12:04"
  }
]
```

To hear a sentence in Ila's voice:

```bash
curl -X POST http://127.0.0.1:8000/speak ^
  -H "Content-Type: application/json" ^
  -d "{\"text\": \"Yesterday I went to the market.\"}"
```

`/chat` runs the tutor itself and includes the result as `feedback`, which is `null` if the tutor failed.

### Scenes

```bash
# Save a dialogue (no OpenAI request)
curl -X POST http://127.0.0.1:8000/scenes -H "Content-Type: application/json" -d @scene.json

# List, read, rename, delete
curl http://127.0.0.1:8000/scenes
curl http://127.0.0.1:8000/scenes/1
curl -X PATCH http://127.0.0.1:8000/scenes/1 -H "Content-Type: application/json" -d "{\"title\": \"Night in the forest\"}"
curl -X DELETE http://127.0.0.1:8000/scenes/1

# A line's audio: made with OpenAI on the first request, served from the database after that
curl -o line.mp3 http://127.0.0.1:8000/scenes/1/lines/2/audio

# Start and finish a practice run. Finishing counts it in the scene's practice_count.
curl -X POST http://127.0.0.1:8000/practice-runs -H "Content-Type: application/json" -d "{\"scene_id\": 1, \"my_role\": \"Maya\"}"
curl -X PATCH http://127.0.0.1:8000/practice-runs/1 -H "Content-Type: application/json" -d "{\"avg_score\": 0.86, \"active_seconds\": 140}"

# Kai offered a saved scene, but the learner wants a new one written anyway
curl -X POST http://127.0.0.1:8000/conversations/<conversation_id>/scenes -H "Content-Type: application/json" ^
  -d "{\"situation\": \"forest at night\", \"topic\": \"strange noise\", \"characters\": [\"Maya\", \"Arjun\"], \"line_count\": 12}"
```

`GET /config` tells the frontend how to voice scenes and where the off-script threshold is: `{ scene_tts_provider, offscript_threshold, goal_minutes }`.

### Daily goal

Learners aim to practise for 60 minutes a day (`DAILY_GOAL_MINUTES`), and days run from midnight to midnight IST. The frontend counts seconds while the learner is in Free Talk or scene practice, the tab is visible, and they spoke, typed or listened to Kai in the last 90 seconds. Every 15 seconds it sends them as a heartbeat. [activity.py](activity.py) adds them to that conversation's row for the day. If a heartbeat crosses midnight, it's split between the two days. A day's total is the sum over all conversations.

```bash
curl -X POST http://127.0.0.1:8000/activity ^
  -H "Content-Type: application/json" ^
  -d "{\"seconds\": 15, \"mode\": \"scene\", \"scene_id\": 3, \"conversation_id\": \"<conversation_id>\"}"
# -> { "date": "2026-10-19", "seconds": 1815, "goal_minutes": 60 }

curl http://127.0.0.1:8000/activity/today

# Minutes for each of the last N days (1–366, default 7), oldest first, ending today
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
