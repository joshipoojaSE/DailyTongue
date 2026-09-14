# DailyTongue API

A minimal FastAPI DailyTongue. Upload an audio file and receive its transcript and assistant response.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Common audio formats such as WAV, MP3, M4A, and WEBM are supported.

Create a `.env` file:

```env
OPENAI_API_KEY=your_api_key
```

## Run

```bash
uvicorn main:app --reload
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
turns to keep the conversation together.

## Tutor feedback

A silent tutor agent reads the whole conversation (learner and Kai) and corrects the
learner's latest message. Kai never sees its feedback. Call it after `/respond` returns,
passing the conversation including Kai's reply:

```bash
curl -X POST http://127.0.0.1:8000/conversations/<conversation_id>/feedback ^
  -H "Content-Type: application/json" ^
  -d "{\"messages\": [{\"role\": \"user\", \"content\": \"yesterday I go to market\"}, {\"role\": \"assistant\", \"content\": \"Nice! What did you buy?\"}]}"
```

`/chat` runs the tutor itself and includes the result as `feedback`, which is `null` if the
tutor failed.

Feedback is stored in SQLite at `dailytongue.db`; set `DATABASE_PATH` to use a different file.
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
    "created_at": "2026-09-13 10:12:04"
  }
]
```
