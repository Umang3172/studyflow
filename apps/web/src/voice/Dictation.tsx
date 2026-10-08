import { useVoiceInput } from "agents/voice/react";
import { useEffect, useRef } from "react";

// Push-to-talk dictation: the transcript goes into the composer for editing; it is never auto-sent.
// The route /agents/voice/<anything> is mapped to this student's VoiceInputAgent by the Worker (the name is ignored).
export function Dictation({ onText }: { onText: (text: string) => void }) {
  const { transcript, interimTranscript, isListening, error, start, stop, clear } = useVoiceInput({ agent: "voice", name: "me" });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Hand finished text to the composer once listening stops.
  useEffect(() => {
    if (!isListening && transcript.trim()) {
      onText(transcript.trim());
      clear();
    }
  }, [isListening, transcript, onText, clear]);

  // Server also ends calls at 60 s; stop the mic here at the same limit.
  useEffect(() => {
    if (isListening) timer.current = setTimeout(stop, 60_000);
    return () => clearTimeout(timer.current);
  }, [isListening, stop]);

  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  if (!supported) return <span className="text-xs text-muted-fg">Voice input is not supported in this browser.</span>;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={`btn ${isListening ? "btn-primary" : ""}`}
        aria-pressed={isListening}
        onClick={() => (isListening ? stop() : void start())}
      >
        {isListening ? "⏹ Stop" : "🎤 Dictate"}
      </button>
      {isListening && (
        <span className="max-w-48 truncate text-xs text-muted-fg" aria-live="polite">
          {interimTranscript || "Listening…"}
        </span>
      )}
      {error && (
        <span className="text-xs text-amber-600" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
