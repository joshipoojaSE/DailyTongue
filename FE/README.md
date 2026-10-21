# DailyTongue Frontend

React (Vite) UI for the DailyTongue API in `../BE`.

Record from your microphone. The app sends the recording to `POST /transcribe` and shows
your transcript as soon as it's ready, then sends that text to `POST /respond` to get the
agent's reply and play its audio.

The conversation id is kept in `localStorage`. On load the app shows the conversation's latest
messages from `GET /conversations/{id}/messages`, and loads older ones as you scroll to the top.

Kai's dialogues can be saved as scenes (**Save as scene**) and practised from **My Scenes**,
playing either character. In scene practice your line is heard by the browser's own speech
recognition (Web Speech API, in Chrome and Edge; elsewhere you type it) and compared with
the script in [src/scene.js](src/scene.js), so it needs no OpenAI request. The practice timer
([src/usePracticeTimer.js](src/usePracticeTimer.js)) counts your active time and sends it
to the backend every 15 seconds.

## Setup

```bash
npm install
```

## Run

Start the backend first (from `../BE`):

```bash
uvicorn main:app --reload
```

Then start the frontend:

```bash
npm run dev
```

Open http://localhost:5173.

In development, requests to `/api/*` are proxied to `http://127.0.0.1:8000`, so the backend
doesn't need CORS. To proxy to a different backend, set `VITE_API_TARGET` before running
`npm run dev`.

For a production build served separately from the API, set `VITE_API_BASE` to the API's URL
(e.g. `VITE_API_BASE=https://api.example.com`) and add CORS middleware to the backend.

## Tests

```bash
npm test
```
