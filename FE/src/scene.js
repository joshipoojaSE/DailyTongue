// Scenes without the network: reading a dialogue out of Kai's message, and scoring a
// spoken or typed line against the script.

// "**Maya:** Arjun, do you hear that?"
export const DIALOGUE_LINE = /^\*\*(.+?):\*\*\s*(.+)$/;
export const MIN_SCENE_LINES = 4;

/**
 * The dialogue in a message as { characters: [a, b], lines: [{ speaker, text }] }, with the
 * characters in the order they first speak; null unless it has exactly two speakers and at
 * least four lines.
 */
export function parseDialogue(text) {
  if (!text) return null;
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(DIALOGUE_LINE);
    if (match) lines.push({ speaker: match[1].trim(), text: match[2].trim() });
  }
  const characters = [...new Set(lines.map((l) => l.speaker))];
  if (characters.length !== 2 || lines.length < MIN_SCENE_LINES) return null;
  return { characters, lines };
}

/** A suggested scene title: the learner's request, or else the first line, shortened. */
export function suggestTitle(request, firstLine) {
  const source = (request || firstLine || "My scene").replace(/\s+/g, " ").trim();
  if (source.length <= 60) return source;
  const cut = source.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
}

// Spoken and written forms that mean the same, so "I'm" and "I am" match. Each pair of
// words is folded into its contraction before comparing.
const CONTRACTIONS = {
  "i am": "i'm",
  "you are": "you're",
  "we are": "we're",
  "they are": "they're",
  "he is": "he's",
  "she is": "she's",
  "it is": "it's",
  "that is": "that's",
  "there is": "there's",
  "what is": "what's",
  "let us": "let's",
  "i have": "i've",
  "you have": "you've",
  "we have": "we've",
  "they have": "they've",
  "i will": "i'll",
  "you will": "you'll",
  "we will": "we'll",
  "they will": "they'll",
  "it will": "it'll",
  "i would": "i'd",
  "you would": "you'd",
  "do not": "don't",
  "does not": "doesn't",
  "did not": "didn't",
  "is not": "isn't",
  "are not": "aren't",
  "was not": "wasn't",
  "were not": "weren't",
  "have not": "haven't",
  "has not": "hasn't",
  "can not": "can't",
  cannot: "can't",
  "could not": "couldn't",
  "should not": "shouldn't",
  "would not": "wouldn't",
  "will not": "won't",
};

// Speech recognition often writes small numbers as digits.
const NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];

function normaliseWord(word) {
  const norm = word
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9']/g, "")
    .replace(/^'+|'+$/g, "");
  return /^\d+$/.test(norm) && NUMBERS[Number(norm)] ? NUMBERS[Number(norm)] : norm;
}

/** The words of a line as [{ display, norm }], ignoring case, punctuation and contractions. */
export function tokenize(text) {
  const words = (text || "")
    .split(/\s+/)
    .map((display) => ({ display, norm: normaliseWord(display) }))
    .filter((w) => w.norm);

  const tokens = [];
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length && `${words[i].norm} ${words[i + 1].norm}`;
    if (pair && CONTRACTIONS[pair]) {
      tokens.push({ display: `${words[i].display} ${words[i + 1].display}`, norm: CONTRACTIONS[pair] });
      i++;
    } else {
      tokens.push({ display: words[i].display, norm: CONTRACTIONS[words[i].norm] ?? words[i].norm });
    }
  }
  return tokens;
}

/**
 * Compares what the learner said with the script line, word by word.
 *
 * Returns { score, ops }: score is 0–1 (1 − word edits ÷ the longer line's length), and ops
 * walk through the line in order:
 *   { type: "same", expected, said }
 *   { type: "missed", expected }        a script word they left out
 *   { type: "extra", said }             a word they added
 *   { type: "changed", expected, said } a script word they said differently
 */
export function compareLines(expected, said) {
  const a = tokenize(expected);
  const b = tokenize(said);
  const n = a.length;
  const m = b.length;

  // dist[i][j]: word edits between the first i script words and the first j said words.
  const dist = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const swap = a[i - 1].norm === b[j - 1].norm ? 0 : 1;
      dist[i][j] = Math.min(dist[i - 1][j - 1] + swap, dist[i - 1][j] + 1, dist[i][j - 1] + 1);
    }
  }

  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1].norm === b[j - 1].norm && dist[i][j] === dist[i - 1][j - 1]) {
      ops.push({ type: "same", expected: a[i - 1].display, said: b[j - 1].display });
      i--;
      j--;
    } else if (i > 0 && j > 0 && dist[i][j] === dist[i - 1][j - 1] + 1) {
      ops.push({ type: "changed", expected: a[i - 1].display, said: b[j - 1].display });
      i--;
      j--;
    } else if (i > 0 && dist[i][j] === dist[i - 1][j] + 1) {
      ops.push({ type: "missed", expected: a[i - 1].display });
      i--;
    } else {
      ops.push({ type: "extra", said: b[j - 1].display });
      j--;
    }
  }
  ops.reverse();

  const longest = Math.max(n, m);
  return { score: longest === 0 ? 1 : 1 - dist[n][m] / longest, ops };
}
