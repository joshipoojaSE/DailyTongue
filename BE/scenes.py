"""Scenes: scripted two-character dialogues the learner saves and practises line by line.

Nothing here touches the database or OpenAI, so it can be tested on its own.
"""

import hashlib
import os
import re

from pydantic import BaseModel

# Each character in a scene gets its own voice, distinct from Kai's (alloy) and Ila's (coral).
VOICE_A = os.getenv("SCENE_VOICE_A", "verse")
VOICE_B = os.getenv("SCENE_VOICE_B", "nova")

MIN_LINES = 4
MAX_LINES = 60


class SceneLine(BaseModel):
    speaker: str
    text: str


class SceneRequest(BaseModel):
    """What Kai's create_scene tool asks for, before any dialogue is written."""

    situation: str
    topic: str
    characters: list[str]
    line_count: int


class GeneratedScene(BaseModel):
    """The strict JSON the scene writer returns."""

    title: str
    situation: str
    topic: str
    characters: list[str]
    lines: list[SceneLine]


def scene_problem(characters: list[str], lines: list[SceneLine]) -> str | None:
    """Why these characters and lines don't make a practisable scene, or None if they do."""
    names = [c.strip() for c in characters]
    if len(names) != 2 or not all(names) or names[0] == names[1]:
        return "A scene needs exactly two different characters"
    if not MIN_LINES <= len(lines) <= MAX_LINES:
        return f"A scene needs {MIN_LINES} to {MAX_LINES} lines"
    for line in lines:
        if line.speaker.strip() not in names:
            return f"{line.speaker!r} isn't one of the scene's characters"
        if not line.text.strip():
            return "Every line needs some text"
    return None


# Words that change how a request is phrased but not which scene it asks for.
_FILLER = {"a", "an", "the", "in", "at", "on", "of", "to", "and", "with", "about", "for"}


def normalise(text: str) -> str:
    """Lowercase words without punctuation or filler, so "In the forest, at night"
    and "forest at night" match."""
    words = re.findall(r"[a-z0-9']+", text.lower())
    return " ".join(w for w in words if w not in _FILLER)


def cache_key(situation: str, topic: str, characters: list[str]) -> str:
    """Identifies a scene request. Character order doesn't matter, since either can go first."""
    names = sorted(normalise(c) for c in characters)
    key = "|".join([normalise(situation), normalise(topic), *names])
    return hashlib.sha256(key.encode()).hexdigest()


def voice_for(speaker: str, char_a: str) -> str:
    return VOICE_A if speaker == char_a else VOICE_B


def to_markdown(scene: GeneratedScene) -> str:
    """The scene as chat text, one "**Name:** line" per line, as Kai writes dialogues."""
    lines = "\n".join(f"**{line.speaker}:** {line.text}" for line in scene.lines)
    return f"Here's your scene: {scene.title}\n\n{lines}"
