# Voice Agent API

A minimal FastAPI voice agent. Upload an audio file and receive its transcript and assistant response.

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

# 2. Text -> { "response": "...", "audio_base64": "..." }
curl -X POST http://127.0.0.1:8000/respond ^
  -H "Content-Type: application/json" ^
  -d "{\"text\": \"Hello, how are you?\"}"
```
