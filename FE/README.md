# DailyTongue Frontend

The React 18 (Vite) UI for the [DailyTongue API](../BE/README.md). It doesn't use a UI framework or chart library. Microphone capture, line scoring and the progress chart are all written by hand on top of browser APIs.

See the [root README](../README.md) for the product overview.

## Views

The app has four views, switched from the header:

| View | Component | What it does |
| ---- | --------- | ------------ |
| **Free Talk** (default) | [App.jsx](src/App.jsx) | Voice or text chat with Kai, Ila's tutor notes under your messages, and infinite-scroll history |
| **My Scenes** | [SceneLibrary.jsx](src/SceneLibrary.jsx) | Saved dialogues with their characters, line count and practice history: **Practice as …**, Rename, Delete |
| **Scene practice** | [ScenePractice.jsx](src/ScenePractice.jsx) | You play one character and Kai plays the other. Each line is scored, and you get a summary at the end. |
| **Progress** | [Dashboard.jsx](src/Dashboard.jsx) | Daily practice time over 7, 30 or 90 days. Opened from the goal ring in the header. |

## Source map

| File | Responsibility |
| ---- | -------------- |
| [App.jsx](src/App.jsx) | Root component: header (goal ring, scenes and progress buttons), chat, composer, view switching, conversation id in `localStorage` |
| [api.js](src/api.js) | One function per backend endpoint. Uses `VITE_API_BASE` or `/api`, and turns FastAPI `detail` errors into messages. |
| [useRecorder.js](src/useRecorder.js) | `MediaRecorder` and Web Audio: live 40-bar waveform, mic level, picks a format the browser supports (`webm`/`m4a`), stops automatically |
| [usePracticeTimer.js](src/usePracticeTimer.js) | Measures active practice time and sends a heartbeat to `POST /activity` every 15 s |
| [scene.js](src/scene.js) | `parseDialogue`, `suggestTitle`, `tokenize`, `compareLines` (pure functions, unit-tested) |
| [SaveScene.jsx](src/SaveScene.jsx) | **Save as scene** on Kai's dialogues, and the "you already have this scene" prompt |
| [common.jsx](src/common.jsx) | Shared pieces: Ila's feedback note, the 🔊 `SpeakButton`, icons, time parsing, MP3 blob URLs |
| [Tongue.jsx](src/Tongue.jsx) | The SVG mascot. `mood` is one of `rest`, `idle`, `happy`, `thinking`, `listening`, `talking` or `oops`; `level` opens its mouth with the mic level; `glasses` is for Ila. |
| [index.css](src/index.css) | All styles and the mascot animations |

## How the main pieces work

**Voice recording.** Tap the mic and a live waveform shows your voice, while the mascot's mouth follows the mic level. Recording stops after **4 s of quiet once you've spoken**. It gives up after 8 s with no speech, and stops at 2 minutes regardless. You can cancel it. The audio goes to `/transcribe`, and your transcript is shown *before* the app asks `/respond` for Kai's reply. Then Kai's MP3 plays. You can also type, and each message is labelled *spoken* or *typed*.

**Tutor notes.** After Kai's reply arrives, the app sends the conversation to Ila (`POST /conversations/{id}/feedback`) and shows her correction, the explained mistakes and a rephrasing under your message. 🔊 fetches a sentence's audio once and replays it from memory after that.

**History.** The conversation id is kept in `localStorage`. On load, the latest 30 messages come from `GET /conversations/{id}/messages`. An `IntersectionObserver` loads older pages as you scroll to the top, keeping your scroll position. Each message shows who sent it, how (spoken or typed) and the time in IST, with *Today*, *Yesterday* or *Tue 8 Sept* dividers.

**Saving scenes.** Any Kai message with at least four `**Name:** line` lines from exactly two speakers gets **Save as scene**. The dialogue is parsed in the browser, so saving makes no OpenAI request. The title starts as your request (or the first line), and you can edit it.

**Scene practice.**
- Kai's lines play from cached audio, or from `speechSynthesis` when the backend says `scene_tts_provider: "browser"`.
- Your next line shows above the input. **Hide line** lets you say it from memory (remembered in `localStorage`), and **Hear it** plays it.
- You speak the line or type it. A spoken line is recorded like Free Talk and sent to `/transcribe` with the script line as `expected`, which helps the transcriber hear accented or hesitant speech. `compareLines` scores it with a word-level edit distance and marks missed, extra and changed words.
- A line that scores below the off-script threshold (`0.7` by default, from `/config`) shows the script line.
- At the end you get your average score, your weakest lines, **Practice again** and **Switch role**. The run is recorded through `/practice-runs`.

**Practice timer.** Time counts only while you're in Free Talk or a scene with the tab visible. Seconds are kept only if you spoke, typed in a text box or listened to Kai within the last 90 s. Otherwise the header shows *paused* and the idle stretch is dropped. Seconds not yet sent are included in the header right away, and the backend keeps the day's total, so it survives a reload.

**Dashboard.** It shows four stats (total, daily average, days the goal was met, best day), a bar chart and a day-by-day list. The chart is plain SVG:
- It resizes with the window through a `ResizeObserver`.
- Bars are pink on days that met the goal, with the goal drawn as a reference line.
- You can read each day by hovering, or by focusing the chart and using the arrow keys.
- Ticks are spaced evenly to suit the data, and dates are formatted at UTC midnight, so the IST calendar day shows the same in any time zone.
- The previous report stays on screen while a new range loads, and loading errors can be retried.

## Setup

```bash
npm install
```

## Run

Start the backend first (from `../BE`):

```powershell
.venv\Scripts\python.exe -m uvicorn main:app --reload
```

Then start the frontend:

```bash
npm run dev
```

Open http://localhost:5173 in any modern browser.

In development, requests to `/api/*` are proxied to `http://127.0.0.1:8000`, so the backend doesn't need CORS. To proxy to a different backend, set `VITE_API_TARGET` before running `npm run dev`.

For a production build (`npm run build`) served separately from the API, set `VITE_API_BASE` to the API's URL (for example `VITE_API_BASE=https://api.example.com`) and add CORS middleware to the backend.

## Tests

```bash
npm test
```

Vitest covers [scene.js](src/scene.js):
- `parseDialogue`: speakers and lines, Windows line endings, the minimum of four lines and two speakers, ignoring ordinary messages and bold text
- `suggestTitle`
- `compareLines`: exact, missed, extra and changed words; script order; contractions; small numbers; unrelated lines and silence
- `tokenize`
