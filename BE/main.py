import asyncio
import base64
import json
import logging
import os
import tempfile
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Query, Response, UploadFile
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

load_dotenv()

# Loaded after .env, since scenes reads its voice settings from the environment.
from activity import MAX_HEARTBEAT_SECONDS, add_activity, today  # noqa: E402
from db import ConnectionPool  # noqa: E402
from scenes import (  # noqa: E402
    GeneratedScene,
    SceneLine,
    SceneRequest,
    cache_key,
    scene_problem,
    to_markdown,
    voice_for,
)

logger = logging.getLogger(__name__)

# Every OpenAI request is logged here (uvicorn doesn't show app INFO logs otherwise),
# so you can check that replaying a scene makes none.
openai_log = logging.getLogger("dailytongue.openai")
openai_log.setLevel(logging.INFO)
if not openai_log.handlers:
    openai_log.addHandler(logging.StreamHandler())
openai_calls = 0


def log_openai(what: str) -> None:
    global openai_calls
    openai_calls += 1
    openai_log.info("openai call #%d: %s", openai_calls, what)


# How Kai's lines are voiced in scene practice: "openai_cached" makes each line's audio
# once and reuses it, "browser" uses the browser's own speech synthesis, which is free.
SCENE_TTS_PROVIDER = os.getenv("SCENE_TTS_PROVIDER", "openai_cached")
if SCENE_TTS_PROVIDER not in ("openai_cached", "browser"):
    raise RuntimeError("SCENE_TTS_PROVIDER must be openai_cached or browser")
# In scene practice, a line that scores below this is marked off-script.
SCENE_OFFSCRIPT_THRESHOLD = float(os.getenv("SCENE_OFFSCRIPT_THRESHOLD", "0.7"))

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is required: the Neon Postgres connection string")

# Neon is reached over the network, so connections are pooled and reused.
# Neon drops idle connections (its proxy closes the socket, and serverless
# computes suspend), so a pooled connection can be dead by the time we reuse it.
# The pool tests one before handing it out and quietly replaces it, and
# max_idle retires connections before Neon does.
pool = ConnectionPool(DATABASE_URL, max_size=10, max_idle=120, max_lifetime=600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield
    pool.close()


app = FastAPI(title="DailyTongue API", lifespan=lifespan)
client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Agent 3: Kai, the conversational partner. Sees only its own conversation
# with the learner, never the tutor's feedback.
SYSTEM_PROMPT = """Your name is Kai. If the user asks who you are, introduce yourself as Kai.
You're an expert voice agent. You are given the transcript of what
user has said using voice. Respond as a voice agent because your response may be
converted back to audio and played to the user.

When the user asks you to write or create a dialogue, scene, script or role-play between
two characters, don't write it yourself: call create_scene.
"""

CREATE_SCENE_TOOL = {
    "type": "function",
    "function": {
        "name": "create_scene",
        "description": "Writes a scripted dialogue between exactly two characters for the"
        " learner to save and practise. Use it whenever the learner asks for a dialogue,"
        " scene, script, role-play or conversation between two characters.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {
                "situation": {
                    "type": "string",
                    "description": "Where it happens and what is going on, as a short"
                    " lowercase noun phrase, e.g. 'forest at night'",
                },
                "topic": {
                    "type": "string",
                    "description": "What the characters talk about, as a short lowercase"
                    " noun phrase, e.g. 'strange noise in the bushes'",
                },
                "characters": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Exactly two first names: the ones the learner gave,"
                    " otherwise two you choose",
                },
                "line_count": {
                    "type": "integer",
                    "description": "Total lines across both characters: what the learner"
                    " asked for (8 each means 16), otherwise 12",
                },
            },
            "required": ["situation", "topic", "characters", "line_count"],
            "additionalProperties": False,
        },
    },
}

# Context for the transcriber, which otherwise mishears accented or hesitant speech.
TRANSCRIBE_PROMPT = (
    "An English learner, often with an Indian accent, speaking casually to a tutor. "
    "Transcribe every word exactly as spoken, including grammar mistakes and repeated words."
)

# Writes the dialogue for a create_scene request, as strict JSON.
SCENE_PROMPT = """You write short scripted dialogues for English learners to practise
speaking aloud. Write natural, everyday spoken English at an intermediate level: short
sentences, common vocabulary, some useful phrases and contractions. The two characters take
turns, starting with the first character. Each line is one or two sentences.

Return JSON with the title (3 to 6 words), the situation, the topic, the two characters
exactly as given, and the lines. Each line's speaker is exactly one of the two character
names."""

# Agent 2: Ila, the tutor. Silently observes the whole conversation and coaches
# the learner's English one message at a time.
TUTOR_PROMPT = """Your name is Ila. You are a warm, encouraging 30-year-old woman and an
experienced English tutor. You are silently observing a conversation between an English
learner and Kai, their conversational partner. You never speak to the learner or to Kai;
you only produce written feedback, in your own friendly, supportive voice.

Correct only the learner's latest message. Use the rest of the conversation, including
Kai's replies, as context for what the learner meant.

- Messages are often speech transcripts, so ignore capitalization and punctuation.
- British and American spellings and usage are both correct; never flag one as a mistake.
- Flag grammar mistakes, wrong or unnatural word choices, and phrasing a fluent speaker
  would not use.
- corrected: the whole message as a fluent speaker would say it, keeping the learner's
  meaning and tone. If nothing needs fixing, repeat the message unchanged.
- mistakes: one entry per issue. original is only the few words that change, quoted exactly
  (for example "movie", not the whole sentence); correction is what replaces them; add a
  short, encouraging explanation. Leave it empty if the message is already correct
  and natural.
- rephrased: another way to say the same thing that sounds more natural or expressive in
  everyday spoken English, so the learner picks up new vocabulary and phrasing. Always
  provide one, even when the message is correct, and make it noticeably different from
  corrected while keeping the meaning and a similar level of difficulty.
"""

SPEAKERS = {"user": "Learner", "assistant": "Kai"}

# Only the most recent turns are sent to the model, to bound prompt size.
MAX_HISTORY_MESSAGES = 20

# Learners aim to practise for this many minutes each day.
DAILY_GOAL_MINUTES = 60
SERVER_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


class TranscribeResponse(BaseModel):
    transcript: str


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


InputMode = Literal["spoken", "typed"]


class RespondRequest(BaseModel):
    messages: list[Message]
    conversation_id: str | None = Field(default=None, max_length=64)
    # How the learner entered their latest message, shown next to it in history.
    input: InputMode | None = None


class SceneRef(BaseModel):
    id: int
    title: str


class Reply(BaseModel):
    response: str
    audio_base64: str
    # Set when Kai wrote a scene: the dialogue, which `response` also holds as text.
    scene: GeneratedScene | None = None
    # Set instead when a saved scene already matches the request: that scene, and the
    # request, to send to /conversations/{id}/scenes for a new one anyway.
    existing_scene: SceneRef | None = None
    scene_request: SceneRequest | None = None


class RespondResponse(Reply):
    conversation_id: str
    user_message_id: int
    message_id: int


class Mistake(BaseModel):
    original: str
    correction: str
    explanation: str


class TutorFeedback(BaseModel):
    corrected: str
    mistakes: list[Mistake]
    rephrased: str


class FeedbackEntry(TutorFeedback):
    id: int
    message: str
    created_at: str


class FeedbackRequest(BaseModel):
    messages: list[Message]
    # The stored id of the user message being corrected, so history can show the feedback.
    message_id: int | None = None


class ChatResponse(RespondResponse):
    transcript: str
    feedback: FeedbackEntry | None


class StoredMessage(BaseModel):
    id: int
    role: Literal["user", "assistant"]
    content: str
    # Learner messages only; null for Kai and for messages saved without it.
    input: InputMode | None
    has_audio: bool
    feedback: FeedbackEntry | None
    # The dialogue, for Kai's messages that wrote a scene.
    scene: GeneratedScene | None = None
    # UTC, "YYYY-MM-DD HH:MM:SS".
    created_at: str


class MessagePage(BaseModel):
    messages: list[StoredMessage]
    has_more: bool


class DayProgress(BaseModel):
    # A calendar day in IST, "YYYY-MM-DD".
    date: str
    minutes: int


class Progress(BaseModel):
    goal_minutes: int
    # Oldest first, ending with today.
    days: list[DayProgress]


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


class SpeakResponse(BaseModel):
    audio_base64: str


class GeneratedSceneMessage(BaseModel):
    message_id: int
    response: str
    scene: GeneratedScene


class SceneCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    situation: str = Field(default="", max_length=500)
    topic: str = Field(default="", max_length=500)
    characters: list[str]
    lines: list[SceneLine]
    # The chat message it was saved from, if any.
    source_message_id: int | None = None


class SceneUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class SceneSummary(BaseModel):
    id: int
    title: str
    situation: str
    topic: str
    characters: list[str]
    line_count: int
    practice_count: int
    source_message_id: int | None
    # UTC, "YYYY-MM-DD HH:MM:SS"; last_practiced_at is null until a run is finished.
    last_practiced_at: str | None
    created_at: str


class StoredSceneLine(BaseModel):
    id: int
    line_no: int
    speaker: str
    text: str
    voice: str | None
    # Whether the line's audio has been made yet. It's at /scenes/{id}/lines/{line_id}/audio,
    # which makes it on the first request.
    has_audio: bool


class SceneDetail(SceneSummary):
    lines: list[StoredSceneLine]


class RunCreate(BaseModel):
    scene_id: int
    my_role: str


class RunUpdate(BaseModel):
    avg_score: float = Field(ge=0, le=1)
    active_seconds: int = Field(default=0, ge=0)


class PracticeRun(BaseModel):
    id: int
    scene_id: int
    my_role: str
    started_at: str
    ended_at: str | None
    avg_score: float | None
    active_seconds: int


class ActivityRequest(BaseModel):
    seconds: int = Field(ge=1, le=MAX_HEARTBEAT_SECONDS)
    mode: Literal["free_talk", "scene"]
    scene_id: int | None = None
    # The learner's conversation, if they have one yet; the seconds are stored under it.
    conversation_id: str | None = Field(default=None, max_length=64)


class ActivityToday(BaseModel):
    # Today in IST, "YYYY-MM-DD".
    date: str
    seconds: int
    goal_minutes: int


class AppConfig(BaseModel):
    scene_tts_provider: Literal["openai_cached", "browser"]
    offscript_threshold: float
    goal_minutes: int


def init_db() -> None:
    with pool.connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS feedback (
                id BIGSERIAL PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                message_id BIGINT,
                message TEXT NOT NULL,
                corrected TEXT NOT NULL,
                mistakes TEXT NOT NULL,
                rephrased TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS feedback_conversation ON feedback (conversation_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS feedback_message ON feedback (message_id)"
        )
        # Every message in a conversation, so the frontend can page back through history.
        # audio holds the MP3 of Kai's replies.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id BIGSERIAL PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                input TEXT,
                audio BYTEA,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS messages_conversation"
            " ON messages (conversation_id, id)"
        )
        # The dialogue of Kai's messages that wrote a scene, as GeneratedScene JSON.
        conn.execute("ALTER TABLE messages ADD COLUMN IF NOT EXISTS scene TEXT")
        # Saved dialogues the learner practises. cache_key identifies the request a
        # generated scene was written for, so asking again can reuse it.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scenes (
                id BIGSERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                situation TEXT NOT NULL DEFAULT '',
                topic TEXT NOT NULL DEFAULT '',
                char_a TEXT NOT NULL,
                char_b TEXT NOT NULL,
                cache_key TEXT UNIQUE,
                source_message_id BIGINT,
                practice_count INTEGER NOT NULL DEFAULT 0,
                last_practiced_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        # audio is the line's MP3, made the first time it's needed and kept for good.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scene_lines (
                id BIGSERIAL PRIMARY KEY,
                scene_id BIGINT NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
                line_no INTEGER NOT NULL,
                speaker TEXT NOT NULL,
                text TEXT NOT NULL,
                audio BYTEA,
                voice TEXT,
                UNIQUE (scene_id, line_no)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS practice_runs (
                id BIGSERIAL PRIMARY KEY,
                scene_id BIGINT NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
                my_role TEXT NOT NULL,
                started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                ended_at TIMESTAMPTZ,
                avg_score REAL,
                active_seconds INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        # Seconds of active practice per conversation and IST day, from the frontend's
        # heartbeats. A day's total is the sum over conversations.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS practice_time (
                conversation_id TEXT NOT NULL,
                day DATE NOT NULL,
                seconds INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (conversation_id, day)
            )
            """
        )


def utc_text(moment: datetime) -> str:
    """A stored timestamp in the format the API returns: UTC, "YYYY-MM-DD HH:MM:SS"."""
    return moment.astimezone(timezone.utc).strftime(SERVER_TIME_FORMAT)


def row_to_feedback(row: dict) -> FeedbackEntry:
    return FeedbackEntry(
        id=row["id"],
        message=row["message"],
        corrected=row["corrected"],
        mistakes=json.loads(row["mistakes"]),
        rephrased=row["rephrased"],
        created_at=utc_text(row["created_at"]),
    )


def save_message(
    conversation_id: str,
    role: str,
    content: str,
    input: InputMode | None = None,
    audio: bytes | None = None,
    scene: GeneratedScene | None = None,
) -> int:
    with pool.connection() as conn:
        row = conn.execute(
            "INSERT INTO messages (conversation_id, role, content, input, audio, scene)"
            " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (
                conversation_id,
                role,
                content,
                input,
                audio,
                scene.model_dump_json() if scene else None,
            ),
        ).fetchone()
    return row["id"]


def save_reply(conversation_id: str, reply: Reply) -> int:
    return save_message(
        conversation_id,
        "assistant",
        reply.response,
        audio=base64.b64decode(reply.audio_base64),
        scene=reply.scene,
    )


def save_feedback(
    conversation_id: str,
    message: str,
    feedback: TutorFeedback,
    message_id: int | None = None,
) -> FeedbackEntry:
    with pool.connection() as conn:
        row = conn.execute(
            "INSERT INTO feedback"
            " (conversation_id, message_id, message, corrected, mistakes, rephrased)"
            " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id, created_at",
            (
                conversation_id,
                message_id,
                message,
                feedback.corrected,
                json.dumps([m.model_dump() for m in feedback.mistakes]),
                feedback.rephrased,
            ),
        ).fetchone()
    return FeedbackEntry(
        id=row["id"],
        message=message,
        created_at=utc_text(row["created_at"]),
        **feedback.model_dump(),
    )


async def transcribe_upload(audio: UploadFile, expected: str | None = None) -> str:
    if not audio.filename:
        raise HTTPException(status_code=400, detail="An audio file is required")

    audio_data = await audio.read()
    file_path = None
    try:
        with tempfile.NamedTemporaryFile(
            suffix=os.path.splitext(audio.filename)[1], delete=False
        ) as file:
            file.write(audio_data)
            file_path = file.name

        try:
            prompt = TRANSCRIBE_PROMPT
            if expected:
                # In scene practice the line is known; telling the model what it's likely
                # to hear stops it guessing at accented or hesitant words.
                prompt += (
                    " They are saying this line from a script, though their words may differ:"
                    f' "{expected}"'
                )
            log_openai("transcribe")
            with open(file_path, "rb") as audio_file:
                transcription = await client.audio.transcriptions.create(
                    model="gpt-4o-mini-transcribe",
                    file=audio_file,
                    language="en",
                    prompt=prompt,
                )
            return transcription.text
        except Exception as error:
            raise HTTPException(status_code=502, detail="Audio transcription failed") from error
    finally:
        if file_path:
            os.unlink(file_path)


async def synthesize(
    text: str, voice: str = "alloy", instructions: str | None = None
) -> str:
    """Speaks the text; returns base64-encoded MP3."""
    options = {"instructions": instructions} if instructions else {}
    log_openai(f"tts ({voice}): {text[:40]!r}")
    try:
        speech = await client.audio.speech.create(
            model="gpt-4o-mini-tts",
            voice=voice,
            input=text,
            response_format="mp3",
            **options,
        )
    except Exception as error:
        raise HTTPException(status_code=502, detail="Speech generation failed") from error
    return base64.b64encode(speech.content).decode()


async def generate_reply(history: list[Message]) -> Reply:
    log_openai("kai reply")
    completion = await client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            *(m.model_dump() for m in history[-MAX_HISTORY_MESSAGES:]),
        ],
        tools=[CREATE_SCENE_TOOL],
    )

    message = completion.choices[0].message
    call = next(
        (c for c in message.tool_calls or () if c.function.name == "create_scene"), None
    )
    if call is not None:
        return await scene_reply(SceneRequest.model_validate_json(call.function.arguments), history)

    response = message.content or ""
    return Reply(response=response, audio_base64=await synthesize(response))


def find_scene(key: str) -> SceneRef | None:
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT id, title FROM scenes WHERE cache_key = %s", (key,)
        ).fetchone()
    return SceneRef(**row) if row else None


async def scene_reply(request: SceneRequest, history: list[Message]) -> Reply:
    """Kai's reply to a create_scene call: a saved scene that matches the request if there
    is one, otherwise a newly written scene."""
    existing = find_scene(cache_key(request.situation, request.topic, request.characters))
    if existing is not None:
        response = (
            f'You already have a saved scene like this: "{existing.title}". Want to practise'
            " that one, or shall I write you a new one?"
        )
        return Reply(
            response=response,
            audio_base64=await synthesize(response),
            existing_scene=existing,
            scene_request=request,
        )

    scene = await write_scene(request, history[-1].content if history else "")
    a, b = scene.characters
    spoken = (
        f"Here's a scene called {scene.title}, with {a} and {b}."
        " Tap Save as scene to practise it."
    )
    # Only the introduction is read aloud; the dialogue is for practice, line by line.
    return Reply(response=to_markdown(scene), audio_base64=await synthesize(spoken), scene=scene)


async def write_scene(request: SceneRequest, learner_request: str) -> GeneratedScene:
    """Writes the dialogue for a scene request as strict JSON. Its situation, topic and
    characters are the request's, so the scene's cache_key matches the request's."""
    if len(request.characters) != 2:
        raise HTTPException(status_code=502, detail="A scene needs exactly two characters")
    line_count = min(max(request.line_count, 4), 30)
    log_openai("write scene")
    try:
        completion = await client.chat.completions.parse(
            model="gpt-4.1-mini",
            messages=[
                {"role": "system", "content": SCENE_PROMPT},
                {
                    "role": "user",
                    "content": f"The learner asked: {learner_request}\n\n"
                    f"Situation: {request.situation}\nTopic: {request.topic}\n"
                    f"Characters: {request.characters[0]}, {request.characters[1]}\n"
                    f"Number of lines: {line_count}",
                },
            ],
            response_format=GeneratedScene,
        )
    except Exception as error:
        logger.exception("Writing a scene failed")
        raise HTTPException(status_code=502, detail="Writing the scene failed") from error

    scene = completion.choices[0].message.parsed
    if scene is None:
        raise HTTPException(status_code=502, detail="Writing the scene failed")
    scene = scene.model_copy(
        update={
            "situation": request.situation,
            "topic": request.topic,
            "characters": [c.strip() for c in request.characters],
            "lines": [
                SceneLine(speaker=line.speaker.strip(), text=line.text.strip())
                for line in scene.lines
            ],
        }
    )
    problem = scene_problem(scene.characters, scene.lines)
    if problem:
        logger.error("The scene writer returned an invalid scene: %s", problem)
        raise HTTPException(status_code=502, detail="Writing the scene failed")
    return scene


async def coach(
    conversation_id: str, conversation: list[Message], message_id: int | None = None
) -> FeedbackEntry:
    """Corrects the learner's latest message in the conversation and stores the feedback."""
    message = next(m.content for m in reversed(conversation) if m.role == "user")
    transcript = "\n".join(
        f"{SPEAKERS[m.role]}: {m.content}" for m in conversation[-MAX_HISTORY_MESSAGES:]
    )

    log_openai("ila feedback")
    try:
        completion = await client.chat.completions.parse(
            model="gpt-4.1-mini",
            messages=[
                {"role": "system", "content": TUTOR_PROMPT},
                {
                    "role": "user",
                    "content": f"Conversation so far:\n{transcript}\n\n"
                    f"Learner's latest message to correct:\n{message}",
                },
            ],
            response_format=TutorFeedback,
        )
    except Exception as error:
        logger.exception("Tutor feedback failed for conversation %s", conversation_id)
        raise HTTPException(status_code=502, detail="Tutor feedback failed") from error

    feedback = completion.choices[0].message.parsed
    if feedback is None:
        logger.error(
            "Tutor returned no parsed feedback for conversation %s (refusal: %s)",
            conversation_id,
            completion.choices[0].message.refusal,
        )
        raise HTTPException(status_code=502, detail="Tutor feedback failed")
    return save_feedback(conversation_id, message, feedback, message_id)


@app.post("/chat", response_model=ChatResponse)
async def chat(
    audio: UploadFile = File(...),
    conversation_id: str | None = Form(default=None, max_length=64),
) -> ChatResponse:
    transcript = await transcribe_upload(audio)
    conversation_id = conversation_id or uuid.uuid4().hex
    user_message = Message(role="user", content=transcript)
    user_message_id = save_message(conversation_id, "user", transcript, "spoken")
    reply = await generate_reply([user_message])
    message_id = save_reply(conversation_id, reply)

    # The reply is still useful without feedback, so a tutor failure isn't fatal here.
    try:
        feedback = await coach(
            conversation_id,
            [user_message, Message(role="assistant", content=reply.response)],
            user_message_id,
        )
    except HTTPException:
        logger.exception("Tutor feedback failed for conversation %s", conversation_id)
        feedback = None

    return ChatResponse(
        transcript=transcript,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        message_id=message_id,
        feedback=feedback,
        **reply.model_dump(),
    )


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    audio: UploadFile = File(...),
    expected: str | None = Form(default=None, max_length=1000),
) -> TranscribeResponse:
    return TranscribeResponse(transcript=await transcribe_upload(audio, expected))


@app.post("/respond", response_model=RespondResponse)
async def respond(request: RespondRequest) -> RespondResponse:
    messages = request.messages
    if not messages or messages[-1].role != "user" or not messages[-1].content.strip():
        raise HTTPException(
            status_code=400, detail="The last message must be non-empty user text"
        )
    conversation_id = request.conversation_id or uuid.uuid4().hex
    # Saved before replying, so the learner's message stays in history even if Kai fails.
    user_message_id = save_message(
        conversation_id, "user", messages[-1].content, request.input
    )
    reply = await generate_reply(messages)
    return RespondResponse(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        message_id=save_reply(conversation_id, reply),
        **reply.model_dump(),
    )


@app.post("/speak", response_model=SpeakResponse)
async def speak(request: SpeakRequest) -> SpeakResponse:
    """Reads a tutor sentence aloud in Ila's voice so the learner can hear how it sounds."""
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text to speak is required")
    audio = await synthesize(
        request.text,
        voice="coral",
        instructions="You are Ila, a warm, friendly 30-year-old woman and English tutor."
        " Speak slowly and clearly, modelling natural pronunciation for a learner.",
    )
    return SpeakResponse(audio_base64=audio)


@app.post("/conversations/{conversation_id}/feedback", response_model=FeedbackEntry)
async def create_feedback(conversation_id: str, request: FeedbackRequest) -> FeedbackEntry:
    latest = next((m for m in reversed(request.messages) if m.role == "user"), None)
    if latest is None or not latest.content.strip():
        raise HTTPException(
            status_code=400, detail="The conversation must include non-empty user text"
        )
    return await coach(conversation_id, request.messages, request.message_id)


@app.get("/conversations/{conversation_id}/feedback", response_model=list[FeedbackEntry])
def list_feedback(conversation_id: str) -> list[FeedbackEntry]:
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT id, message, corrected, mistakes, rephrased, created_at FROM feedback"
            " WHERE conversation_id = %s ORDER BY id",
            (conversation_id,),
        ).fetchall()
    return [row_to_feedback(row) for row in rows]


@app.get("/conversations/{conversation_id}/messages", response_model=MessagePage)
def list_messages(
    conversation_id: str,
    before: int | None = Query(default=None, description="Only messages older than this id"),
    limit: int = Query(default=30, ge=1, le=100),
) -> MessagePage:
    """The newest `limit` messages (older than `before`, if given), oldest first."""
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT id, role, content, input, audio IS NOT NULL AS has_audio, scene, created_at"
            " FROM messages WHERE conversation_id = %s"
            " AND (%s::bigint IS NULL OR id < %s::bigint)"
            " ORDER BY id DESC LIMIT %s",
            (conversation_id, before, before, limit + 1),
        ).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit][::-1]

        ids = [row["id"] for row in rows if row["role"] == "user"]
        # If a message was checked more than once, the latest feedback wins.
        feedback = {
            row["message_id"]: row_to_feedback(row)
            for row in conn.execute(
                "SELECT id, message_id, message, corrected, mistakes, rephrased, created_at"
                " FROM feedback WHERE message_id = ANY(%s::bigint[]) ORDER BY id",
                (ids,),
            )
        }

    return MessagePage(
        messages=[
            StoredMessage(
                id=row["id"],
                role=row["role"],
                content=row["content"],
                input=row["input"],
                has_audio=bool(row["has_audio"]),
                feedback=feedback.get(row["id"]),
                scene=GeneratedScene.model_validate_json(row["scene"]) if row["scene"] else None,
                created_at=utc_text(row["created_at"]),
            )
            for row in rows
        ],
        has_more=has_more,
    )


@app.get("/messages/{message_id}/audio")
def message_audio(message_id: int) -> Response:
    """The MP3 of one of Kai's stored replies."""
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT audio FROM messages WHERE id = %s", (message_id,)
        ).fetchone()
    if row is None or row["audio"] is None:
        raise HTTPException(status_code=404, detail="No audio for this message")
    return Response(content=row["audio"], media_type="audio/mpeg")


@app.get("/config", response_model=AppConfig)
def app_config() -> AppConfig:
    """Settings the frontend follows, so they live in one place, BE/.env."""
    return AppConfig(
        scene_tts_provider=SCENE_TTS_PROVIDER,
        offscript_threshold=SCENE_OFFSCRIPT_THRESHOLD,
        goal_minutes=DAILY_GOAL_MINUTES,
    )


class SceneDraftRequest(SceneRequest):
    # What the learner asked for, as context for the writer.
    request: str = Field(default="", max_length=2000)


@app.post("/conversations/{conversation_id}/scenes", response_model=GeneratedSceneMessage)
async def write_new_scene(
    conversation_id: str, request: SceneDraftRequest
) -> GeneratedSceneMessage:
    """Writes a new scene even though a saved one matches the request, and adds it to the
    conversation as a message from Kai (without audio)."""
    scene = await write_scene(request, request.request)
    response = to_markdown(scene)
    message_id = save_message(conversation_id, "assistant", response, scene=scene)
    return GeneratedSceneMessage(message_id=message_id, response=response, scene=scene)


SCENE_COLUMNS = (
    "s.id, s.title, s.situation, s.topic, s.char_a, s.char_b, s.practice_count,"
    " s.source_message_id, s.last_practiced_at, s.created_at,"
    " (SELECT count(*) FROM scene_lines l WHERE l.scene_id = s.id) AS line_count"
)


def row_to_scene(row: dict) -> SceneSummary:
    return SceneSummary(
        id=row["id"],
        title=row["title"],
        situation=row["situation"],
        topic=row["topic"],
        characters=[row["char_a"], row["char_b"]],
        line_count=row["line_count"],
        practice_count=row["practice_count"],
        source_message_id=row["source_message_id"],
        last_practiced_at=(
            utc_text(row["last_practiced_at"]) if row["last_practiced_at"] else None
        ),
        created_at=utc_text(row["created_at"]),
    )


def load_scene(conn, scene_id: int) -> SceneDetail:
    row = conn.execute(
        f"SELECT {SCENE_COLUMNS} FROM scenes s WHERE s.id = %s", (scene_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such scene")
    lines = conn.execute(
        "SELECT id, line_no, speaker, text, voice, audio IS NOT NULL AS has_audio"
        " FROM scene_lines WHERE scene_id = %s ORDER BY line_no",
        (scene_id,),
    ).fetchall()
    return SceneDetail(
        **row_to_scene(row).model_dump(),
        lines=[StoredSceneLine(**line) for line in lines],
    )


@app.post("/scenes", response_model=SceneDetail)
def create_scene(request: SceneCreate) -> SceneDetail:
    """Saves a dialogue as a scene: one parsed from a chat message, or one Kai wrote as JSON.
    Saving the same message twice returns the scene saved the first time."""
    characters = [c.strip() for c in request.characters]
    lines = [SceneLine(speaker=l.speaker.strip(), text=l.text.strip()) for l in request.lines]
    problem = scene_problem(characters, lines)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    # Only generated scenes, which have a situation and topic, can be matched to a request.
    key = (
        cache_key(request.situation, request.topic, characters)
        if request.situation.strip() or request.topic.strip()
        else None
    )

    with pool.connection() as conn:
        if request.source_message_id is not None:
            saved = conn.execute(
                "SELECT id FROM scenes WHERE source_message_id = %s",
                (request.source_message_id,),
            ).fetchone()
            if saved:
                return load_scene(conn, saved["id"])
        # The learner asked for a new scene although one matched; the first keeps the key.
        if key and conn.execute("SELECT 1 FROM scenes WHERE cache_key = %s", (key,)).fetchone():
            key = None

        scene_id = conn.execute(
            "INSERT INTO scenes"
            " (title, situation, topic, char_a, char_b, cache_key, source_message_id)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                request.title.strip(),
                request.situation.strip(),
                request.topic.strip(),
                characters[0],
                characters[1],
                key,
                request.source_message_id,
            ),
        ).fetchone()["id"]
        conn.execute(
            "INSERT INTO scene_lines (scene_id, line_no, speaker, text)"
            " SELECT %s, n, speaker, text"
            " FROM unnest(%s::int[], %s::text[], %s::text[]) AS t (n, speaker, text)",
            (
                scene_id,
                list(range(1, len(lines) + 1)),
                [line.speaker for line in lines],
                [line.text for line in lines],
            ),
        )
        return load_scene(conn, scene_id)


@app.get("/scenes", response_model=list[SceneSummary])
def list_scenes() -> list[SceneSummary]:
    """Saved scenes, most recently practised (or saved) first."""
    with pool.connection() as conn:
        rows = conn.execute(
            f"SELECT {SCENE_COLUMNS} FROM scenes s"
            " ORDER BY COALESCE(s.last_practiced_at, s.created_at) DESC, s.id DESC"
        ).fetchall()
    return [row_to_scene(row) for row in rows]


@app.get("/scenes/{scene_id}", response_model=SceneDetail)
def get_scene(scene_id: int) -> SceneDetail:
    with pool.connection() as conn:
        return load_scene(conn, scene_id)


@app.patch("/scenes/{scene_id}", response_model=SceneDetail)
def rename_scene(scene_id: int, request: SceneUpdate) -> SceneDetail:
    with pool.connection() as conn:
        conn.execute(
            "UPDATE scenes SET title = %s WHERE id = %s", (request.title.strip(), scene_id)
        )
        return load_scene(conn, scene_id)


@app.delete("/scenes/{scene_id}")
def delete_scene(scene_id: int) -> dict:
    """Deletes the scene with its lines, their audio and its practice runs."""
    with pool.connection() as conn:
        row = conn.execute(
            "DELETE FROM scenes WHERE id = %s RETURNING id", (scene_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such scene")
    return {"id": scene_id}


# One request at a time makes a line's audio, so two at once (a browser often sends more
# than one request for a media file) don't both pay for it.
line_audio_locks: dict[int, asyncio.Lock] = {}


def stored_line(scene_id: int, line_id: int) -> dict:
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT l.speaker, l.text, l.audio, s.char_a FROM scene_lines l"
            " JOIN scenes s ON s.id = l.scene_id WHERE l.id = %s AND l.scene_id = %s",
            (line_id, scene_id),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such scene line")
    return row


@app.get("/scenes/{scene_id}/lines/{line_id}/audio")
async def scene_line_audio(scene_id: int, line_id: int) -> Response:
    """The MP3 of one scene line in its character's voice. It's made on the first request
    and stored, so every later one is served without calling OpenAI."""
    row = stored_line(scene_id, line_id)
    audio = row["audio"]
    if audio is None:
        async with line_audio_locks.setdefault(line_id, asyncio.Lock()):
            # Made by another request while this one waited?
            row = stored_line(scene_id, line_id)
            audio = row["audio"]
            if audio is None:
                voice = voice_for(row["speaker"], row["char_a"])
                audio = base64.b64decode(
                    await synthesize(
                        row["text"],
                        voice=voice,
                        instructions=f"You are {row['speaker']}, a character in a short"
                        " everyday scene. Say the line naturally, with feeling, at a pace an"
                        " English learner can follow.",
                    )
                )
                with pool.connection() as conn:
                    conn.execute(
                        "UPDATE scene_lines SET audio = %s, voice = %s WHERE id = %s",
                        (audio, voice, line_id),
                    )

    # A line's text never changes, so browsers can keep its audio for good.
    return Response(
        content=bytes(audio),
        media_type="audio/mpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


RUN_COLUMNS = "id, scene_id, my_role, started_at, ended_at, avg_score, active_seconds"


def row_to_run(row: dict) -> PracticeRun:
    return PracticeRun(
        id=row["id"],
        scene_id=row["scene_id"],
        my_role=row["my_role"],
        started_at=utc_text(row["started_at"]),
        ended_at=utc_text(row["ended_at"]) if row["ended_at"] else None,
        avg_score=row["avg_score"],
        active_seconds=row["active_seconds"],
    )


@app.post("/practice-runs", response_model=PracticeRun)
def start_run(request: RunCreate) -> PracticeRun:
    """Starts practising a scene, with the learner playing `my_role`."""
    with pool.connection() as conn:
        scene = conn.execute(
            "SELECT char_a, char_b FROM scenes WHERE id = %s", (request.scene_id,)
        ).fetchone()
        if scene is None:
            raise HTTPException(status_code=404, detail="No such scene")
        if request.my_role not in (scene["char_a"], scene["char_b"]):
            raise HTTPException(status_code=400, detail="my_role must be one of the characters")
        row = conn.execute(
            "INSERT INTO practice_runs (scene_id, my_role) VALUES (%s, %s)"
            f" RETURNING {RUN_COLUMNS}",
            (request.scene_id, request.my_role),
        ).fetchone()
    return row_to_run(row)


@app.patch("/practice-runs/{run_id}", response_model=PracticeRun)
def finish_run(run_id: int, request: RunUpdate) -> PracticeRun:
    """Finishes a run, counting it towards its scene's practice_count. A run that has
    already finished is left as it was."""
    with pool.connection() as conn:
        finished = conn.execute(
            "UPDATE practice_runs SET ended_at = now(), avg_score = %s, active_seconds = %s"
            " WHERE id = %s AND ended_at IS NULL RETURNING scene_id",
            (request.avg_score, request.active_seconds, run_id),
        ).fetchone()
        if finished:
            conn.execute(
                "UPDATE scenes SET practice_count = practice_count + 1,"
                " last_practiced_at = now() WHERE id = %s",
                (finished["scene_id"],),
            )
        row = conn.execute(
            f"SELECT {RUN_COLUMNS} FROM practice_runs WHERE id = %s", (run_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such practice run")
    return row_to_run(row)


def activity_today(conn) -> ActivityToday:
    day = today()
    row = conn.execute(
        "SELECT COALESCE(SUM(seconds), 0) AS seconds FROM practice_time WHERE day = %s", (day,)
    ).fetchone()
    return ActivityToday(
        date=day.isoformat(),
        seconds=row["seconds"],
        goal_minutes=DAILY_GOAL_MINUTES,
    )


@app.post("/activity", response_model=ActivityToday)
def record_activity(request: ActivityRequest) -> ActivityToday:
    """A heartbeat from the frontend: seconds of active practice (speaking or typing, tab
    visible) that just ended, in Free Talk or a scene. Returns today's new total."""
    with pool.connection() as conn:
        add_activity(
            conn, request.conversation_id, datetime.now(timezone.utc), request.seconds
        )
        return activity_today(conn)


@app.get("/activity/today", response_model=ActivityToday)
def get_activity_today() -> ActivityToday:
    with pool.connection() as conn:
        return activity_today(conn)


@app.get("/activity", response_model=Progress)
def activity_by_day(
    days: int = Query(default=7, ge=1, le=366, description="How many days, ending today"),
) -> Progress:
    """Minutes practised on each of the last `days` days (IST), oldest first."""
    first_day = today() - timedelta(days=days - 1)
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT day, SUM(seconds) AS seconds FROM practice_time"
            " WHERE day >= %s GROUP BY day",
            (first_day,),
        ).fetchall()

    active = {row["day"]: row["seconds"] for row in rows}
    return Progress(
        goal_minutes=DAILY_GOAL_MINUTES,
        days=[
            DayProgress(date=day.isoformat(), minutes=active.get(day, 0) // 60)
            for day in (first_day + timedelta(days=i) for i in range(days))
        ],
    )
