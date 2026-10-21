import { describe, expect, it } from "vitest";
import { compareLines, parseDialogue, suggestTitle, tokenize } from "./scene.js";

const MAYA_ARJUN = `Sure! Here's a short dialogue:

**Maya:** Arjun, do you hear that rustling in the bushes?
**Arjun:** I heard it too, Maya. It could be an animal.
**Maya:** Should we take a closer look?
**Arjun:** Carefully. Stay behind me.

Have fun practising!`;

describe("parseDialogue", () => {
  it("reads the speakers and lines of a dialogue, ignoring the text around it", () => {
    expect(parseDialogue(MAYA_ARJUN)).toEqual({
      characters: ["Maya", "Arjun"],
      lines: [
        { speaker: "Maya", text: "Arjun, do you hear that rustling in the bushes?" },
        { speaker: "Arjun", text: "I heard it too, Maya. It could be an animal." },
        { speaker: "Maya", text: "Should we take a closer look?" },
        { speaker: "Arjun", text: "Carefully. Stay behind me." },
      ],
    });
  });

  it("handles Windows line endings and indented lines", () => {
    const text = "  **A:** one\r\n**B:** two\r\n**A:** three\r\n  **B:** four";
    expect(parseDialogue(text).lines).toHaveLength(4);
  });

  it("needs at least four lines", () => {
    expect(parseDialogue("**Maya:** Hi\n**Arjun:** Hello\n**Maya:** Bye")).toBeNull();
  });

  it("needs exactly two speakers", () => {
    expect(parseDialogue("**Maya:** Hi\n**Maya:** Hello\n**Maya:** Hey\n**Maya:** Bye")).toBeNull();
    expect(
      parseDialogue("**Maya:** Hi\n**Arjun:** Hello\n**Leo:** Hey\n**Maya:** Bye\n**Arjun:** Bye")
    ).toBeNull();
  });

  it("ignores ordinary messages, bold text and empty input", () => {
    expect(parseDialogue("Nice! What did you buy?")).toBeNull();
    expect(parseDialogue("**Tip:** speak slowly.")).toBeNull();
    expect(parseDialogue("")).toBeNull();
    expect(parseDialogue(undefined)).toBeNull();
  });

  it("only accepts the colon inside the bold name", () => {
    expect(parseDialogue("**Maya**: Hi\n**Arjun**: Hello\n**Maya**: Hey\n**Arjun**: Bye")).toBeNull();
  });
});

describe("suggestTitle", () => {
  it("uses the request, or the first line when there is none", () => {
    expect(suggestTitle("Maya and Arjun in the forest", "Hi")).toBe("Maya and Arjun in the forest");
    expect(suggestTitle("", "Arjun, do you hear that?")).toBe("Arjun, do you hear that?");
  });

  it("shortens long text at a word boundary", () => {
    const title = suggestTitle(
      "Can you please write a dialogue between Maya and Arjun who are lost in a forest at night",
      ""
    );
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("compareLines", () => {
  const LINE = "Arjun, do you hear that rustling in the bushes?";

  it("scores an exact line 1, ignoring case and punctuation", () => {
    const { score, ops } = compareLines(LINE, "arjun do you hear that rustling in the bushes");
    expect(score).toBe(1);
    expect(ops.every((op) => op.type === "same")).toBe(true);
  });

  it("marks missed words", () => {
    const { score, ops } = compareLines(LINE, "Arjun do you hear rustling in the bushes");
    expect(ops.filter((op) => op.type === "missed")).toEqual([{ type: "missed", expected: "that" }]);
    expect(score).toBeCloseTo(1 - 1 / 9);
  });

  it("marks extra words", () => {
    const { ops } = compareLines(LINE, "Arjun do you really hear that rustling in the bushes");
    expect(ops.filter((op) => op.type === "extra")).toEqual([{ type: "extra", said: "really" }]);
  });

  it("marks changed words", () => {
    const { score, ops } = compareLines(LINE, "Arjun do you hear that noise in the bushes");
    expect(ops.filter((op) => op.type !== "same")).toEqual([
      { type: "changed", expected: "rustling", said: "noise" },
    ]);
    expect(score).toBeCloseTo(8 / 9);
  });

  it("keeps the words in script order", () => {
    const { ops } = compareLines("I heard it too", "I heard too");
    expect(ops.map((op) => op.type)).toEqual(["same", "same", "missed", "same"]);
  });

  it("treats contractions and their long forms as the same", () => {
    expect(compareLines("I'm sure it's fine", "I am sure it is fine").score).toBe(1);
    expect(compareLines("Don't worry", "do not worry").score).toBe(1);
    expect(compareLines("Don’t worry", "don't worry").score).toBe(1);
  });

  it("treats small numbers and their words as the same", () => {
    expect(compareLines("I have two tickets", "I have 2 tickets").score).toBe(1);
  });

  it("scores an unrelated line low", () => {
    expect(compareLines(LINE, "I would like a cup of tea please").score).toBeLessThan(0.3);
  });

  it("scores silence 0 and an empty script against silence 1", () => {
    expect(compareLines(LINE, "").score).toBe(0);
    expect(compareLines("", "").score).toBe(1);
  });
});

describe("tokenize", () => {
  it("keeps what was written for display", () => {
    expect(tokenize("I am here.")).toEqual([
      { display: "I am", norm: "i'm" },
      { display: "here.", norm: "here" },
    ]);
  });
});
