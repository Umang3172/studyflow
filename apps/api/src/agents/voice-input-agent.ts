import { Agent, getAgentByName, type Connection } from "agents";
import { WorkersAINova3STT, withVoiceInput } from "agents/voice";

// Dictation only: speech-to-text into the chat composer. No TTS, no LLM, nothing persisted here.
// The daily cap and usage live in the student's StudyAgent (single source of truth); this class asks it.

const InputAgent = withVoiceInput(Agent);
const MAX_CALL_MS = 60_000;

export class VoiceInputAgent extends InputAgent<Cloudflare.Env> {
  static options = { sendIdentityOnConnect: false }; // the instance name is the internal user id
  transcriber = new WorkersAINova3STT(this.env.AI);
  private calls = new Map<string, { startedAt: number; timer: ReturnType<typeof setTimeout> }>();

  private study() {
    return getAgentByName(this.env.StudyAgent, this.name);
  }

  async beforeCallStart(_connection: Connection) {
    return (await (await this.study()).voiceSecondsLeft()) > 0;
  }

  onCallStart(connection: Connection) {
    // Each push-to-talk call is capped at 60 s; closing the socket ends the call.
    const timer = setTimeout(() => connection.close(4000, "voice call limit"), MAX_CALL_MS);
    this.calls.set(connection.id, { startedAt: Date.now(), timer });
  }

  async onCallEnd(connection: Connection) {
    const call = this.calls.get(connection.id);
    if (!call) return;
    clearTimeout(call.timer);
    this.calls.delete(connection.id);
    const seconds = Math.min(MAX_CALL_MS / 1000, Math.ceil((Date.now() - call.startedAt) / 1000));
    await (await this.study()).recordVoice(seconds);
  }
}
