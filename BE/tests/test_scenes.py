from scenes import (
    VOICE_A,
    VOICE_B,
    GeneratedScene,
    SceneLine,
    cache_key,
    scene_problem,
    to_markdown,
    voice_for,
)


def lines(*pairs):
    return [SceneLine(speaker=s, text=t) for s, t in pairs]


DIALOGUE = lines(
    ("Maya", "Arjun, do you hear that rustling in the bushes?"),
    ("Arjun", "I heard it too, Maya. It could be an animal."),
    ("Maya", "Should we take a closer look?"),
    ("Arjun", "Carefully. Stay behind me."),
)


def test_a_two_character_dialogue_is_valid():
    assert scene_problem(["Maya", "Arjun"], DIALOGUE) is None


def test_a_scene_needs_exactly_two_different_characters():
    assert scene_problem(["Maya"], DIALOGUE)
    assert scene_problem(["Maya", "Arjun", "Leo"], DIALOGUE)
    assert scene_problem(["Maya", "Maya"], DIALOGUE)


def test_a_scene_needs_at_least_four_lines():
    assert scene_problem(["Maya", "Arjun"], DIALOGUE[:3])


def test_every_speaker_must_be_a_character():
    assert scene_problem(["Maya", "Arjun"], DIALOGUE + lines(("Leo", "Hello?")))


def test_cache_key_ignores_case_punctuation_filler_and_character_order():
    assert cache_key("In the forest, at night", "A strange noise!", ["Maya", "Arjun"]) == (
        cache_key("forest night", "strange noise", ["arjun", "MAYA"])
    )


def test_cache_key_differs_for_a_different_request():
    base = cache_key("forest at night", "strange noise", ["Maya", "Arjun"])
    assert base != cache_key("beach at night", "strange noise", ["Maya", "Arjun"])
    assert base != cache_key("forest at night", "lost map", ["Maya", "Arjun"])
    assert base != cache_key("forest at night", "strange noise", ["Maya", "Leo"])


def test_each_character_has_its_own_voice():
    assert voice_for("Maya", "Maya") == VOICE_A
    assert voice_for("Arjun", "Maya") == VOICE_B
    assert VOICE_A != VOICE_B


def test_markdown_uses_the_chat_dialogue_format():
    scene = GeneratedScene(
        title="Noise in the Forest",
        situation="forest at night",
        topic="strange noise",
        characters=["Maya", "Arjun"],
        lines=DIALOGUE,
    )
    text = to_markdown(scene)
    assert "**Maya:** Arjun, do you hear that rustling in the bushes?" in text.splitlines()
    assert sum(line.startswith("**") for line in text.splitlines()) == 4
