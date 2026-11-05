# Why we tried Groq for speech-to-text, and why we went back to OpenAI

**Decision:** DailyTongue keeps using OpenAI's `gpt-4o-mini-transcribe` to turn the learner's voice into text. We tried Groq's `whisper-large-v3` and reverted it. With real speech, Groq often wrote down words the learner never said.

## What we wanted

Every time a learner taps the mic, their recording is turned into text before Kai can answer. That step adds to the wait. Groq runs OpenAI's open-source Whisper model on very fast hardware, so we tried it to make the app feel quicker.

The speed gain was real. On the same short test clip:

| Provider | Time to transcribe |
|---|---|
| Groq `whisper-large-v3` | about 0.3–0.6 seconds |
| OpenAI `gpt-4o-mini-transcribe` | about 0.9–2 seconds |

If Groq was down or rate-limited, the app fell back to OpenAI, so learners would never be stuck.

## What went wrong

Speed only helps if the words are right. In real use, Groq kept changing what the learner said.

### Example 1: words that were never spoken

The learner talked about Diwali. Groq produced:

> "Tune in to the video to learn more about the The teacher will not determine too much from the number of letters written, given like the youth characters that are used in today's class. That's it."

None of this was said: no video, no teacher, no class. "Tune in to the video" comes from YouTube. Whisper learned from millions of YouTube captions, and when it can't make out the audio it sometimes fills the gap with caption-style phrases.

### Example 2: the meaning changed

The learner asked Kai for a scene between **two brothers** at Diwali. Groq produced:

> "Create a scene where a **teacher** teaches Diwali and how Diwali is important in his life…"

Because of this one wrong word, Kai would write a teacher-and-student scene instead of a brothers scene.

### Why "teacher" kept appearing

Along with each recording, the app sends a short hint to help with accents: *"An English learner… speaking casually to a tutor."* OpenAI's model treats that as a description of the speaker. Whisper doesn't follow instructions like that. It treats the hint as words that were spoken just before the recording and steers its guesses to match. So "tutor" became "teacher", "class" and "today's class".

We confirmed this with a recording of only background hiss. Groq returned the hint itself, word for word:

> "Transcribe every word exactly as spoken, including grammar mistakes and repeated words."

### We tried a fix, and it still wasn't good enough

We stopped sending the hint to Groq. We also added a check that sends known made-up phrases ("Tune in to the video", "Thanks for watching") to OpenAI instead. Clean test recordings then came out right, but real speech was still changed:

| What the learner said | What Groq wrote |
|---|---|
| "**Create** a scene between two sisters. They are talking about **Holi**…" | "**We had** a scene between two sisters. They are talking about **Holly**…" |

"Create a scene" is a request, and "We had a scene" is a statement about the past, so the meaning changed. "Holi" became the name "Holly". A filter can catch phrases we already know about, but it can't catch a real word swapped for another real word.

### OpenAI with the same kind of request

Back on OpenAI, the learner asked for the two-brothers scene again. OpenAI wrote:

> "Now, day after see between **two brothers**, they are at the beginning of **Diwali**, and both age between 10 to 15…"

It isn't perfect: "create a scene" came out as "day after see". But the important words were all kept: two brothers, Diwali, the ages. Kai could still understand the request.

## Why accuracy matters more than speed here

DailyTongue is a speaking practice app, and the transcript is the base for everything after it:

- **Kai** replies to the transcript. Wrong words lead to a reply about something the learner never said.
- **Ila, the tutor,** corrects the transcript. If the model invents words, Ila "corrects" mistakes the learner never made.
- **Scene practice** scores the learner's line against the script. Invented or swapped words make the score unfair.

Saving about one second isn't worth showing learners sentences they didn't say.

## What we changed

Everything was reverted:

- Transcription uses OpenAI `gpt-4o-mini-transcribe` again, exactly as before the trial.
- The Groq code, the `STT_PROVIDER` setting and the `.env.example` file were removed.

## If we try again

These results come from a small number of recordings by one speaker. The two failures we'd expect to see again are invented words on unclear audio and real words swapped for other real words. A future trial should:

- record a fixed set of real learner sentences, including Indian English and Hindi words like *Diwali*, *Holi* and *diya*;
- send the same recordings to both providers and compare the results word by word;
- switch only if the faster provider is at least as accurate on that set.
