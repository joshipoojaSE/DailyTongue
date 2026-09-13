# Voice Agent

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
| POST   | `/respond`    | JSON `{ "text": "..." }`    | `{ response, audio_base64 }`               |
| POST   | `/chat`       | multipart form, `audio` file | `{ transcript, response, audio_base64 }`   |

`audio_base64` holds MP3 audio. The API accepts common audio formats such as WAV, MP3, M4A, and WEBM. Interactive docs are at http://127.0.0.1:8000/docs while the server is running.

## Configuration

| Variable          | Where      | Purpose                                                               |
| ----------------- | ---------- | --------------------------------------------------------------------- |
| `OPENAI_API_KEY`  | `BE/.env`  | OpenAI API key (required)                                             |
| `VITE_API_TARGET` | FE (dev)   | Backend URL for the dev proxy (default `http://127.0.0.1:8000`)        |
| `VITE_API_BASE`   | FE (build) | API URL for a production build hosted separately from the backend    |

If you serve the frontend build from a different origin than the API, add CORS middleware to the backend.

See [BE/README.md](BE/README.md) and [FE/README.md](FE/README.md) for more details.
