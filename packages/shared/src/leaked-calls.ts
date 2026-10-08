// Llama 3.3 sometimes writes a tool call into its answer as plain text ("Here is a function call: {"name": "remember",
// "parameters": {...}}") instead of making a structured call. Students must not see that, and it must not go back into
// the model's history as an example to copy. This removes JSON blocks that call one of OUR tools (so JSON a tutor
// legitimately writes is untouched), plus the lead-in line that introduced them. It works on complete text, so the
// browser can apply it to a half-streamed message and the server to a finished one.

const TOOLS = "remember|createReminder|listUpcoming|cancelReminder|startStudyPlan|logQuizResult";
const START = new RegExp(`\\{\\s*"name"\\s*:\\s*"(?:${TOOLS})"`);
const LEAD_IN = /\b(function|tool) calls?\b|\bjson\b|\bcall(ing)? (the )?\w* ?(function|tool)\b/i;

/** Index just past the `}` that closes the block starting at `from`, or -1 if it is not closed yet. */
function blockEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

export function stripLeakedToolCalls(text: string): string {
  let out = text;
  for (let guard = 0; guard < 10; guard++) {
    const m = START.exec(out);
    if (!m) break;
    const end = blockEnd(out, m.index);
    let head = out.slice(0, m.index).trimEnd();
    // Drop one short lead-in line directly before the block ("Here is a function call in JSON format:").
    const cut = head.lastIndexOf("\n");
    const lastLine = head.slice(cut + 1);
    if (lastLine.length < 160 && LEAD_IN.test(lastLine)) head = head.slice(0, Math.max(cut, 0)).trimEnd();
    out = end === -1 ? head : `${head}${head ? "\n" : ""}${out.slice(end).trimStart()}`;
    if (end === -1) break;
  }
  return out.trimEnd();
}
