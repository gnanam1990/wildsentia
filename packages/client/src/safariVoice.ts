import type { SafariAnswer } from "@vana/shared";
import type { Room } from "livekit-client";
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult:
    | ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};
interface VoiceOptions {
  answer(q: string): Promise<void>;
  status(text: string): void;
  received(a: SafariAnswer): void;
  start(): Promise<{ url: string; token: string; expiresInSeconds: number }>;
  stop(): Promise<unknown>;
}
export class SafariVoice {
  private recognition: Recognition | null = null;
  private room: Room | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private audio: HTMLMediaElement[] = [];
  private connecting = false;
  constructor(private readonly options: VoiceOptions) {}
  listen(): void {
    const w = window as unknown as {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!C) {
      this.options.status(
        "Speech recognition is unavailable here. Type a question instead.",
      );
      return;
    }
    this.recognition?.stop();
    const r = (this.recognition = new C());
    r.lang = document.documentElement.lang || "en";
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript;
      if (text) void this.options.answer(text.slice(0, 280));
    };
    r.onerror = () =>
      this.options.status(
        "Microphone input was unavailable. You can still type a question.",
      );
    r.onend = () => {
      if (this.recognition === r) this.recognition = null;
      this.options.status("Microphone stopped.");
    };
    try {
      r.start();
      this.options.status(
        "Listening. Your browser handles speech recognition.",
      );
    } catch {
      this.options.status(
        "Could not start the microphone. Try again or type your question.",
      );
    }
  }
  async connect(): Promise<void> {
    if (this.connecting || this.room) return;
    this.connecting = true;
    const generation = ++this.generation;
    this.options.status("Connecting to your live guide…");
    try {
      const [{ Room, RoomEvent }, session] = await Promise.all([
        import("livekit-client"),
        this.options.start(),
      ]);
      if (generation !== this.generation) {
        await this.options.stop();
        return;
      }
      const room = (this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
      }));
      let heardAgent = false;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== "audio") return;
        heardAgent = true;
        const a = track.attach();
        this.audio.push(a);
        document.body.append(a);
        a.style.display = "none";
      });
      room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (topic !== "safari" || !participant) return;
        try {
          if (payload.byteLength > 10_000) return;
          const a: unknown = JSON.parse(new TextDecoder().decode(payload));
          if (
            a &&
            typeof a === "object" &&
            "source" in a &&
            a.source === "checkpoint" &&
            "answer" in a &&
            typeof a.answer === "string" &&
            a.answer.length <= 4000 &&
            "worldTime" in a &&
            typeof a.worldTime === "number"
          )
            this.options.received(a as SafariAnswer);
        } catch {
          /* Ignore unrelated or malformed room data. */
        }
      });
      room.on(RoomEvent.Disconnected, () => {
        if (this.room === room) {
          void this.stop();
          this.options.status(
            "Live voice disconnected. You can continue with text.",
          );
        }
      });
      await room.connect(session.url, session.token);
      if (generation !== this.generation) {
        await room.disconnect();
        return;
      }
      await room.startAudio();
      await room.localParticipant.setMicrophoneEnabled(true);
      this.options.status(
        "Live guide connected. Your microphone audio is sent to the configured voice service.",
      );
      this.timer = setTimeout(() => {
        void this.stop();
      }, session.expiresInSeconds * 1000);
      setTimeout(() => {
        if (this.room === room && !heardAgent) {
          this.options.status(
            "The voice worker did not join. Use the browser microphone or text guide.",
          );
          void this.stop();
        }
      }, 20_000);
    } catch (e) {
      await this.stop();
      throw e;
    } finally {
      this.connecting = false;
    }
  }
  async stop(): Promise<void> {
    ++this.generation;
    this.recognition?.stop();
    this.recognition = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const room = this.room;
    this.room = null;
    if (room) await room.disconnect(true);
    for (const a of this.audio) {
      a.pause();
      a.remove();
    }
    this.audio = [];
    if (room || this.connecting)
      await this.options.stop().catch(() => undefined);
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }
}
