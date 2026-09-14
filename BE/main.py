import base64
import json
import logging
import os
import sqlite3
import tempfile
import uuid
from contextlib import asynccontextmanager, closing
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

load_dotenv()

logger = logging.getLogger(__name__)

DB_PATH = os.getenv(
    "DATABASE_PATH", os.path.join(os.path.dirname(__file__), "dailytongue.db")
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


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


class TranscribeResponse(BaseModel):
    transcript: str


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class RespondRequest(BaseModel):
    messages: list[Message]
    conversation_id: str | None = Field(default=None, max_length=64)


class Reply(BaseModel):
    response: str
    audio_base64: str


class RespondResponse(Reply):
    conversation_id: str


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


class ChatResponse(RespondResponse):
    transcript: str
    feedback: FeedbackEntry | None


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


class SpeakResponse(BaseModel):
    audio_base64: str


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with closing(connect()) as conn, conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                message TEXT NOT NULL,
                corrected TEXT NOT NULL,
                mistakes TEXT NOT NULL,
                rephrased TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # Databases created before rephrasing was added lack the column.
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(feedback)")}
        if "rephrased" not in columns:
            conn.execute(
                "ALTER TABLE feedback ADD COLUMN rephrased TEXT NOT NULL DEFAULT ''"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS feedback_conversation ON feedback (conversation_id)"
        )


def save_feedback(
    conversation_id: str, message: str, feedback: TutorFeedback
) -> FeedbackEntry:
    with closing(connect()) as conn, conn:
        (row,) = conn.execute(
            "INSERT INTO feedback (conversation_id, message, corrected, mistakes, rephrased)"
            " VALUES (?, ?, ?, ?, ?) RETURNING id, created_at",
            (
                conversation_id,
                message,
                feedback.corrected,
                json.dumps([m.model_dump() for m in feedback.mistakes]),
                feedback.rephrased,
            ),
        ).fetchall()
    return FeedbackEntry(
        id=row["id"], message=message, created_at=row["created_at"], **feedback.model_dump()
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


async def coach(conversation_id: str, conversation: list[Message]) -> FeedbackEntry:
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
        raise HTTPException(status_code=502, detail="Tutor feedback failed") from error

    feedback = completion.choices[0].message.parsed
    if feedback is None:
        raise HTTPException(status_code=502, detail="Tutor feedback failed")
    return save_feedback(conversation_id, message, feedback)


@app.post("/chat", response_model=ChatResponse)
async def chat(
    audio: UploadFile = File(...),
    conversation_id: str | None = Form(default=None, max_length=64),
) -> ChatResponse:
    transcript = await transcribe_upload(audio)
    conversation_id = conversation_id or uuid.uuid4().hex
    user_message = Message(role="user", content=transcript)
    reply = await generate_reply([user_message])

    # The reply is still useful without feedback, so a tutor failure isn't fatal here.
    try:
        feedback = await coach(
            conversation_id,
            [user_message, Message(role="assistant", content=reply.response)],
        )
    except HTTPException:
        logger.exception("Tutor feedback failed for conversation %s", conversation_id)
        feedback = None

    return ChatResponse(
        transcript=transcript,
        conversation_id=conversation_id,
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
    reply = await generate_reply(messages)
    return RespondResponse(
        conversation_id=request.conversation_id or uuid.uuid4().hex,
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
    return await coach(conversation_id, request.messages)


@app.get("/conversations/{conversation_id}/feedback", response_model=list[FeedbackEntry])
def list_feedback(conversation_id: str) -> list[FeedbackEntry]:
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT id, message, corrected, mistakes, rephrased, created_at FROM feedback"
            " WHERE conversation_id = ? ORDER BY id",
            (conversation_id,),
        ).fetchall()
    return [
        FeedbackEntry(**{**dict(row), "mistakes": json.loads(row["mistakes"])})
        for row in rows
    ]
