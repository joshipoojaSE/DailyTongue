import base64
import os
import tempfile

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from openai import AsyncOpenAI
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="DailyTongue API")
client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

SYSTEM_PROMPT = """You're an expert voice agent. You are given the transcript of what
user has said using voice. Respond as a voice agent because your response may be
converted back to audio and played to the user.
"""


class ChatResponse(BaseModel):
    transcript: str
    response: str
    audio_base64: str


class TranscribeResponse(BaseModel):
    transcript: str


class RespondRequest(BaseModel):
    text: str


class RespondResponse(BaseModel):
    response: str
    audio_base64: str


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


async def generate_reply(transcript: str) -> RespondResponse:
    completion = await client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": transcript},
        ],
    )

    response = completion.choices[0].message.content or ""

    try:
        speech = await client.audio.speech.create(
            model="gpt-4o-mini-tts",
            voice="alloy",
            input=response,
            response_format="mp3",
        )
    except Exception as error:
        raise HTTPException(status_code=502, detail="Speech generation failed") from error

    return RespondResponse(
        response=response,
        audio_base64=base64.b64encode(speech.content).decode(),
    )


@app.post("/chat", response_model=ChatResponse)
async def chat(audio: UploadFile = File(...)) -> ChatResponse:
    transcript = await transcribe_upload(audio)
    reply = await generate_reply(transcript)
    return ChatResponse(transcript=transcript, **reply.model_dump())


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(audio: UploadFile = File(...)) -> TranscribeResponse:
    return TranscribeResponse(transcript=await transcribe_upload(audio))


@app.post("/respond", response_model=RespondResponse)
async def respond(request: RespondRequest) -> RespondResponse:
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")
    return await generate_reply(request.text)
