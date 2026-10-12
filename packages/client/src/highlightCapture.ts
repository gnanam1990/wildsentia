export interface HighlightOptions {
  duration: 15 | 20 | 30;
  title: string;
  caption: string;
  context: string;
}
export interface CaptureHandle {
  cancel(): void;
  done: Promise<{ bytes: ArrayBuffer; mime: string }>;
}
/** A clip uses the ending of its actual recording, without inventing missing footage. */
export function highlightStart(
  durationMs: number,
  clipSeconds: number,
): number {
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    ![15, 20, 30].includes(clipSeconds)
  )
    throw new Error("Invalid highlight window");
  return Math.max(0, durationMs - clipSeconds * 1000) / durationMs;
}
/** A real canvas capture. It never fills gaps with generated action footage. */
export function captureHighlight(
  source: HTMLCanvasElement,
  options: HighlightOptions,
): CaptureHandle {
  if (
    typeof MediaRecorder === "undefined" ||
    !HTMLCanvasElement.prototype.captureStream
  )
    throw new Error("Video capture is unavailable in this browser.");
  const output = document.createElement("canvas");
  output.width = 720;
  output.height = 1280;
  const ctx = output.getContext("2d");
  if (!ctx) throw new Error("Video canvas unavailable.");
  const mime = [
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error("No supported recording format.");
  const stream = output.captureStream(30);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 2_500_000,
    });
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    throw error;
  }
  let animation = 0,
    timer: ReturnType<typeof setTimeout> | null = null,
    cancelled = false,
    total = 0;
  const chunks: BlobPart[] = [];
  const wrap = (
    text: string,
    y: number,
    font: string,
    colour: string,
    maxLines: number,
  ) => {
    ctx.font = font;
    ctx.fillStyle = colour;
    const words = text.split(/\s+/);
    let line = "",
      n = 0;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > 620 && line) {
        ctx.fillText(line, 50, y);
        y += 40;
        n++;
        line = word;
        if (n >= maxLines) return;
      } else line = test;
    }
    if (line) ctx.fillText(line, 50, y);
  };
  const draw = () => {
    ctx.fillStyle = "#0d1611";
    ctx.fillRect(0, 0, 720, 1280);
    const scale = Math.max(720 / source.width, 1000 / source.height),
      w = source.width * scale,
      h = source.height * scale;
    ctx.drawImage(source, (720 - w) / 2, (1030 - h) / 2, w, h);
    const fade = ctx.createLinearGradient(0, 820, 0, 1280);
    fade.addColorStop(0, "rgba(13,22,17,0)");
    fade.addColorStop(0.35, "rgba(13,22,17,.9)");
    fade.addColorStop(1, "#0d1611");
    ctx.fillStyle = fade;
    ctx.fillRect(0, 800, 720, 480);
    wrap("WILDSENTIA", 57, "600 22px sans-serif", "#a5e3ad", 1);
    wrap(options.title.slice(0, 150), 980, "600 38px sans-serif", "#ecf3ec", 2);
    wrap(options.caption.slice(0, 400), 1080, "28px sans-serif", "#d5e2d6", 3);
    wrap(options.context.slice(0, 150), 1240, "19px sans-serif", "#b3c6b7", 1);
    animation = requestAnimationFrame(draw);
  };
  const hidden = () => {
    if (document.hidden) {
      cancelled = true;
      if (recorder.state !== "inactive") recorder.stop();
    }
  };
  document.addEventListener("visibilitychange", hidden);
  const cleanup = () => {
    document.removeEventListener("visibilitychange", hidden);
    cancelAnimationFrame(animation);
    if (timer) clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
  };
  const done = new Promise<{ bytes: ArrayBuffer; mime: string }>(
    (resolve, reject) => {
      recorder.ondataavailable = (e) => {
        total += e.data.size;
        if (total > 20_000_000) {
          cancelled = true;
          if (recorder.state !== "inactive") recorder.stop();
        } else if (e.data.size) chunks.push(e.data);
      };
      recorder.onerror = () => {
        cleanup();
        reject(new Error("Recording failed."));
      };
      recorder.onstop = () => {
        cleanup();
        if (cancelled) {
          reject(new Error("Recording cancelled."));
          return;
        }
        const blob = new Blob(chunks, { type: mime });
        if (blob.size < 1000) {
          reject(new Error("No video frames were recorded."));
          return;
        }
        void blob.arrayBuffer().then((bytes) => resolve({ bytes, mime }));
      };
    },
  );
  try {
    draw();
    recorder.start(1000);
  } catch (error) {
    cleanup();
    throw error;
  }
  timer = setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, options.duration * 1000);
  return {
    done,
    cancel() {
      cancelled = true;
      if (recorder.state !== "inactive") recorder.stop();
      else cleanup();
    },
  };
}
