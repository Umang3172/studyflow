import { useEffect, useRef, useState } from "react";
import { LIMITS } from "@studyflow/shared";
import { Dictation } from "../voice/Dictation.tsx";

export function Composer(props: {
  busy: boolean;
  disabled: boolean;
  voice: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onClear?: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const t = text.trim();
    if (!t || props.busy || props.disabled) return;
    props.onSend(t);
    setText("");
  };
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, [text]);
  const left = LIMITS.userMessageChars - text.length;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label htmlFor="composer" className="sr-only">
        Message
      </label>
      <textarea
        id="composer"
        ref={ref}
        rows={1}
        className="field resize-none"
        value={text}
        maxLength={LIMITS.userMessageChars}
        disabled={props.disabled}
        placeholder="Ask a question, or say “quiz me on…”"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="flex items-center gap-2">
        {props.voice && <Dictation onText={(t) => setText((cur) => (cur ? `${cur} ${t}` : t).slice(0, LIMITS.userMessageChars))} />}
        {props.onClear && (
          <button type="button" className="btn" onClick={props.onClear} disabled={props.busy}>
            Clear chat
          </button>
        )}
        <span className={`ml-auto text-xs ${left < 200 ? "text-amber-600" : "text-muted-fg"}`}>{left < 1000 ? `${left} left` : ""}</span>
        {props.busy ? (
          <button type="button" className="btn" onClick={props.onStop}>
            Stop
          </button>
        ) : (
          <button className="btn btn-primary" disabled={!text.trim() || props.disabled}>
            Send
          </button>
        )}
      </div>
    </form>
  );
}
