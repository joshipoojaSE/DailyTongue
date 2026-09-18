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
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

load_dotenv()

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is required: the Neon Postgres connection string")

# Neon is reached over the network, so connections are pooled and reused.
pool = ConnectionPool(
    DATABASE_URL,
    min_size=1,
    max_size=10,
    kwargs={"row_factory": dict_row},
    open=False,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool.open()
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
"""

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

# Learners aim to talk with Kai for this many minutes each day.
DAILY_GOAL_MINUTES = 60
# A longer gap between messages means the learner stepped away, so it isn't counted.
IDLE_GAP = timedelta(minutes=5)
# Days start at midnight India Standard Time, as in the frontend. IST has no daylight saving.
IST = timezone(timedelta(hours=5, minutes=30))
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


class Reply(BaseModel):
    response: str
    audio_base64: str


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
        # How long the learner practised on each day, kept up to date as messages
        # are saved, so progress is read rather than recomputed from every message.
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


def record_practice_time(conn, conversation_id: str, message_id: int, at: datetime) -> None:
    """Adds the time since the conversation's previous message to that day's total.
    A gap longer than IDLE_GAP means the learner stepped away, and a gap across
    midnight belongs to neither day, so neither is counted."""
    previous = conn.execute(
        "SELECT created_at FROM messages WHERE conversation_id = %s AND id < %s"
        " ORDER BY id DESC LIMIT 1",
        (conversation_id, message_id),
    ).fetchone()
    if previous is None:
        return

    at = at.astimezone(IST)
    before = previous["created_at"].astimezone(IST)
    if before.date() != at.date() or at - before > IDLE_GAP:
        return

    conn.execute(
        "INSERT INTO practice_time (conversation_id, day, seconds) VALUES (%s, %s, %s)"
        " ON CONFLICT (conversation_id, day)"
        " DO UPDATE SET seconds = practice_time.seconds + EXCLUDED.seconds",
        (conversation_id, at.date(), round((at - before).total_seconds())),
    )


def save_message(
    conversation_id: str,
    role: str,
    content: str,
    input: InputMode | None = None,
    audio: bytes | None = None,
) -> int:
    with pool.connection() as conn:
        row = conn.execute(
            "INSERT INTO messages (conversation_id, role, content, input, audio)"
            " VALUES (%s, %s, %s, %s, %s) RETURNING id, created_at",
            (conversation_id, role, content, input, audio),
        ).fetchone()
        record_practice_time(conn, conversation_id, row["id"], row["created_at"])
    return row["id"]


def save_reply(conversation_id: str, reply: Reply) -> int:
    return save_message(
        conversation_id,
        "assistant",
        reply.response,
        audio=base64.b64decode(reply.audio_base64),
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


async def transcribe_upload(audio: UploadFile) -> str:
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
            with open(file_path, "rb") as audio_file:
                transcription = await client.audio.transcriptions.create(
                    model="gpt-4o-mini-transcribe",
                    file=audio_file,
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
    completion = await client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            *(m.model_dump() for m in history[-MAX_HISTORY_MESSAGES:]),
        ],
    )

    response = completion.choices[0].message.content or ""
    return Reply(response=response, audio_base64=await synthesize(response))


async def coach(
    conversation_id: str, conversation: list[Message], message_id: int | None = None
) -> FeedbackEntry:
    """Corrects the learner's latest message in the conversation and stores the feedback."""
    message = next(m.content for m in reversed(conversation) if m.role == "user")
    transcript = "\n".join(
        f"{SPEAKERS[m.role]}: {m.content}" for m in conversation[-MAX_HISTORY_MESSAGES:]
    )

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
async def transcribe(audio: UploadFile = File(...)) -> TranscribeResponse:
    return TranscribeResponse(transcript=await transcribe_upload(audio))


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
            "SELECT id, role, content, input, audio IS NOT NULL AS has_audio, created_at"
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
                created_at=utc_text(row["created_at"]),
            )
            for row in rows
        ],
        has_more=has_more,
    )


@app.get("/conversations/{conversation_id}/progress", response_model=Progress)
def practice_progress(
    conversation_id: str,
    days: int = Query(default=7, ge=1, le=366, description="How many days, ending today"),
) -> Progress:
    """Minutes spent talking with Kai on each of the last `days` days (IST), as recorded
    by record_practice_time when each message was saved."""
    first_day = datetime.now(IST).date() - timedelta(days=days - 1)
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT day, seconds FROM practice_time"
            " WHERE conversation_id = %s AND day >= %s",
            (conversation_id, first_day),
        ).fetchall()

    active = {row["day"]: row["seconds"] for row in rows}
    return Progress(
        goal_minutes=DAILY_GOAL_MINUTES,
        days=[
            DayProgress(date=day.isoformat(), minutes=active.get(day, 0) // 60)
            for day in (first_day + timedelta(days=i) for i in range(days))
        ],
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
