import type {
  ArenaCommand,
  ArenaFrame,
  ExperienceJob,
  ForestMoment,
  FollowedLife,
  LabResult,
  LabSample,
  LeaguePlayer,
  LeagueStanding,
  SafariAnswer,
} from "@vana/shared";
import { mountThemeButton } from "./theme.js";
import { isAnimalLinkId } from "./animalLink.js";
import type { ArenaView } from "./arenaView.js";
import { SafariVoice } from "./safariVoice.js";
import { nearestHuntable } from "./arenaControls.js";
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  cls = "",
) => {
  const n = document.createElement(tag);
  n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const button = (text: string, action: () => void, cls = "quiet") => {
  const b = node("button", text, cls);
  b.type = "button";
  b.onclick = action;
  return b;
};
const message = (text: string) => {
  $("experience-status").textContent = text;
};
const readable = (e: unknown) =>
  e instanceof Error
    ? e.message
    : "This experience is unavailable. Please try again.";
async function api<T>(path: string, data?: unknown): Promise<T> {
  const r = await fetch(`/api/experiences/${path}`, {
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(15_000),
    ...(data !== undefined
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Wildsentia-Experience": "1",
          },
          body: JSON.stringify(data),
        }
      : {}),
  });
  const p = await r.json().catch(() => null);
  if (!r.ok)
    throw new Error(
      typeof p?.error === "string"
        ? p.error.replaceAll("_", " ")
        : "Connection unavailable. Please try again.",
    );
  return p as T;
}
function download(data: Blob | string, name: string): void {
  const url = URL.createObjectURL(
    typeof data === "string"
      ? new Blob([data], { type: "application/json" })
      : data,
  );
  const a = node("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
const forestUrl = (animal: string | null, event?: ForestMoment) => {
  const u = new URL("/", location.origin);
  u.searchParams.set("embed", "experiences");
  u.searchParams.set("cinema", "1");
  if (animal && isAnimalLinkId(animal))
    u.hash = new URLSearchParams({
      animal,
      ...(event?.replay ? { event: event.id, kind: event.replay } : {}),
    }).toString();
  return u.href;
};
const worldDay = (time: number) =>
  `Year ${Math.floor(time / 86400 / 360) + 1} · day ${(Math.floor(time / 86400) % 360) + 1}`;
let tab = "league";
let league: ExperienceJob | null = null,
  lab: ExperienceJob | null = null,
  replayStandings: LeagueStanding[] = [];
let poll: ReturnType<typeof setTimeout> | null = null;
let lifePoll: ReturnType<typeof setTimeout> | null = null;
let selectedMoment: ForestMoment | null = null,
  clipUrl: string | null = null;
let momentReady = false,
  momentSession = "",
  leagueEpoch = 0,
  labEpoch = 0;
let humanSubmittedTurn: number | null = null;
let profileReady = false;
let selectedAnimal: string | null = null,
  seenThrough = 0,
  notifications = false,
  closed = false,
  replayTimer: ReturnType<typeof setInterval> | null = null;
const notified = new Set<string>();
const cards = new Map<
  string,
  {
    root: HTMLElement;
    canvas: HTMLCanvasElement;
    info: HTMLElement;
    points: HTMLElement;
    view: ArenaView | null;
    frame: ArenaFrame;
  }
>();
mountThemeButton($("experience-theme"));

function selectTab(): void {
  const desired = location.hash.slice(1);
  tab = ["league", "moments", "safari", "lives", "lab"].includes(desired)
    ? desired
    : "league";
  document
    .querySelectorAll<HTMLElement>("[data-pane]")
    .forEach((p) => (p.hidden = p.dataset.pane !== tab));
  document.querySelectorAll<HTMLAnchorElement>("[data-tab]").forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (tab === "moments")
    void refreshMoments().catch((e) => message(readable(e)));
  if (tab === "safari" && !$("safari-forest").getAttribute("src"))
    ($("safari-forest") as HTMLIFrameElement).src = forestUrl(selectedAnimal);
  if (tab === "lives" && profileReady)
    void refreshLives().catch((e) => message(readable(e)));
  if (tab !== "safari") void voice.stop();
  for (const [id, visible] of [
    ["safari-forest", tab === "safari"],
    ["moment-forest", tab === "moments"],
  ] as const)
    ($(`${id}`) as HTMLIFrameElement).contentWindow?.postMessage(
      { type: "wildsentia:visibility", visible: visible && !document.hidden },
      location.origin,
    );
  if (tab !== "moments")
    ($("moment-forest") as HTMLIFrameElement).contentWindow?.postMessage(
      { type: "wildsentia:cancel-capture" },
      location.origin,
    );
}
const voice = new SafariVoice({
  answer: (q) => askSafari(q),
  status: (s) => ($("safari-voice-status").textContent = s),
  received: (a) => showAnswer(a, false),
  start: () =>
    api<{ url: string; token: string; expiresInSeconds: number }>("voice", {}),
  stop: () => api("voice/stop", {}),
});
addEventListener("hashchange", selectTab);

async function busy(
  form: HTMLFormElement,
  work: () => Promise<void>,
): Promise<void> {
  const b = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  b.disabled = true;
  message("");
  try {
    await work();
  } catch (e) {
    message(readable(e));
  } finally {
    b.disabled = false;
  }
}
function clearArenas() {
  for (const c of cards.values()) c.view?.dispose();
  cards.clear();
  $("league-arenas").replaceChildren();
}
async function drawStanding(s: LeagueStanding): Promise<void> {
  let c = cards.get(s.player.id);
  if (!c) {
    const root = node("article", "", "arena-card"),
      head = node("div", "", "arena-title"),
      points = node("strong", "", "arena-points"),
      canvas = node("canvas", "", "arena-canvas"),
      info = node("div", "", "arena-info");
    head.append(node("h4", s.player.label), points);
    canvas.width = 640;
    canvas.height = 360;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      `${s.player.label}'s arena; arrow keys move your animal when playing`,
    );
    root.append(head, canvas, info);
    $("league-arenas").append(root);
    c = { root, canvas, info, points, view: null, frame: s.frame };
    cards.set(s.player.id, c);
    canvas.addEventListener("keydown", (e) => {
      if (
        s.player.source !== "human" ||
        !c?.frame.animal ||
        league?.status !== "running"
      )
        return;
      const a = c.frame.animal;
      const d: Record<string, [number, number]> = {
        ArrowUp: [0, -35],
        ArrowDown: [0, 35],
        ArrowLeft: [-35, 0],
        ArrowRight: [35, 0],
      };
      if (d[e.key]) {
        e.preventDefault();
        const [x, z] = d[e.key]!;
        void humanCommand({
          action: "go_to",
          x: a.x + x,
          z: a.z + z,
          gait: "trot",
        });
      }
      if (e.key === "Escape") {
        e.preventDefault();
        void humanCommand({ action: "stop" });
      }
      if (e.key.toLowerCase() === "h") {
        void humanHunt();
      }
    });
    const { ArenaView } = await import("./arenaView.js");
    if (closed || cards.get(s.player.id) !== c) return;
    c.view = new ArenaView(
      canvas,
      s.player.source === "human"
        ? (x, z) => {
            if (league?.status === "running")
              void humanCommand({ action: "go_to", x, z, gait: "trot" });
          }
        : null,
    );
  }
  if (league?.status === "running" && s.frame.second < c.frame.second) return;
  c.frame = s.frame;
  c.view?.update(s.frame);
  c.points.textContent = `${s.frame.points} pts`;
  const f = s.frame;
  const state =
    s.status === "provider_error"
      ? "Model unavailable — disqualified"
      : f.completedAt !== null
        ? `Mission met at ${f.completedAt}s`
        : !f.alive
          ? "Life ended"
          : `${f.second}s · ${f.animal?.state ?? "Waiting"}`;
  c.info.replaceChildren(
    node("strong", state),
    node(
      "p",
      f.drives
        ? `Thirst ${Math.round(f.drives.thirst * 100)}% · Hunger ${Math.round(f.drives.hunger * 100)}% · Stamina ${Math.round(f.stamina * 100)}%`
        : "",
    ),
    node(
      "p",
      `Turn ${f.turn}/8 · ${f.commandReady ? "Command ready" : `Next turn in ${f.nextTurnIn}s`}`,
    ),
    node("p", f.notice),
  );
}
async function renderLeague(job: ExperienceJob): Promise<void> {
  if (league?.id !== job.id) humanSubmittedTurn = null;
  league = job;
  $("league-match").hidden = false;
  const request = job.request as {
    mission: string;
    species: string;
    durationSeconds: number;
    players: string[];
  };
  $("league-match-title").textContent =
    `${request.species} · ${request.mission === "water" ? "Find water" : request.mission === "hunt" ? "Complete a hunt" : "Stay alive"}`;
  const result = job.result && "standings" in job.result ? job.result : null;
  const standings = result?.standings ?? job.progress.standings ?? [];
  for (const s of standings) await drawStanding(s);
  $("league-progress").textContent = result
    ? result.winners.length
      ? `Winner: ${standings
          .filter((s) => result.winners.includes(s.player.id))
          .map((s) => s.player.label)
          .join(" & ")}`
      : "No entry met the mission"
    : job.status === "running"
      ? `In progress · ${Math.round(job.progress.percent)}%`
      : (job.error?.replaceAll("_", " ") ?? job.status);
  ($("league-meter") as HTMLProgressElement).value =
    job.status === "completed" ? 100 : job.progress.percent;
  $("league-cancel").hidden = job.status !== "running";
  $("league-human").hidden =
    job.status !== "running" || !request.players.includes("human");
  syncHumanControls();
  $("league-replay").hidden = !result;
  if (result) {
    replayStandings = result.standings;
    const max = Math.max(0, ...result.standings.map((s) => s.frame.second));
    ($("league-seek") as HTMLInputElement).max = String(max);
    ($("league-seek") as HTMLInputElement).value = String(max);
  }
}
function syncHumanControls(): void {
  const frame = cards.get("human")?.frame;
  const ready =
    league?.status === "running" &&
    !!frame?.commandReady &&
    frame.turn !== humanSubmittedTurn;
  document
    .querySelectorAll<HTMLButtonElement>("#league-human button")
    .forEach((b) => (b.disabled = !ready));
  cards.get("human")?.canvas.setAttribute("aria-disabled", String(!ready));
}
async function humanHunt(): Promise<void> {
  const frame = cards.get("human")?.frame;
  const id = frame ? nearestHuntable(frame) : null;
  if (!id) {
    message("No huntable prey nearby. Move closer first.");
    return;
  }
  await humanCommand({ action: "hunt", preyId: id });
}
$("league-hunt").onclick = () => void humanHunt();
async function humanCommand(command: ArenaCommand): Promise<void> {
  if (!league || league.status !== "running") return;
  const frame = cards.get("human")?.frame;
  if (!frame?.commandReady || frame.turn === humanSubmittedTurn) {
    message("Wait for your next command turn.");
    return;
  }
  const jobId = league.id;
  humanSubmittedTurn = frame.turn;
  syncHumanControls();
  try {
    await api(`jobs/${jobId}/command`, command);
    message("Command sent. Your next turn will open automatically.");
  } catch (e) {
    if (league?.id === jobId) humanSubmittedTurn = null;
    syncHumanControls();
    message(readable(e));
  }
}
document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(
  (b) =>
    (b.onclick = () =>
      void humanCommand({
        action: b.dataset.action as
          "drink" | "graze" | "rest" | "feed" | "stop",
      })),
);
$("league-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  void busy(form, async () => {
    const f = new FormData(form);
    leagueEpoch++;
    league = null;
    clearArenas();
    if (replayTimer) {
      clearInterval(replayTimer);
      replayTimer = null;
    }
    const j = await api<ExperienceJob>("league", {
      mission: f.get("mission"),
      species: f.get("species"),
      durationSeconds: Number(f.get("duration")),
      players: [f.get("first"), f.get("second")],
      seed: Number(f.get("seed")),
    });
    await renderLeague(j);
    schedulePoll();
    await refreshJobs();
  });
});
$("league-cancel").onclick = () =>
  void (async () => {
    if (league) {
      await api(`jobs/${league.id}/cancel`, {});
      await refreshJob("league");
    }
  })().catch((e) => message(readable(e)));
$("league-export").onclick = () => {
  if (league?.result)
    download(
      JSON.stringify(league, null, 2),
      `wildsentia-match-${league.id}.json`,
    );
};
function seekReplay() {
  const second = Number(($("league-seek") as HTMLInputElement).value);
  for (const s of replayStandings) {
    const f = s.frames.filter((f) => f.second <= second).at(-1) ?? s.frames[0];
    if (f) void drawStanding({ ...s, frame: f });
  }
}
$("league-seek").oninput = seekReplay;
$("league-replay-play").onclick = () => {
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
    $("league-replay-play").textContent = "Play replay";
    return;
  }
  const seek = $("league-seek") as HTMLInputElement;
  if (Number(seek.value) >= Number(seek.max)) seek.value = "0";
  $("league-replay-play").textContent = "Pause replay";
  replayTimer = setInterval(() => {
    if (document.hidden) return;
    seek.value = String(Number(seek.value) + 1);
    seekReplay();
    if (Number(seek.value) >= Number(seek.max)) {
      clearInterval(replayTimer!);
      replayTimer = null;
      $("league-replay-play").textContent = "Play replay";
    }
  }, 500);
};

async function refreshLeaderboard() {
  const p = await api<{
    matches: Array<{
      request: { mission: string; species: string };
      result: { standings: LeagueStanding[]; winners: string[] };
      createdAt: string;
    }>;
  }>("leaderboard");
  const root = $("leaderboard");
  root.replaceChildren();
  if (!p.matches.length)
    root.append(node("p", "Start a match to add a new story to the board."));
  const table = node("table"),
    head = node("tr");
  for (const t of ["Mission", "Animal", "Winner", "Points"])
    head.append(node("th", t));
  table.append(head);
  for (const m of p.matches.slice(0, 12)) {
    const r = node("tr"),
      w = m.result.standings.filter((s) =>
        m.result.winners.includes(s.player.id),
      );
    for (const t of [
      m.request.mission,
      m.request.species,
      w.map((s) => s.player.label).join(" & ") || "No finisher",
      w.map((s) => String(s.frame.points)).join(" / ") || "—",
    ])
      r.append(node("td", t));
    table.append(r);
  }
  root.append(table);
  const season = p as typeof p & {
    season: string;
    rows: Array<{
      player_label: string;
      mission: string;
      species: string;
      matches: number;
      wins: number;
      points: string;
    }>;
  };
  if (season.rows?.length) {
    root.append(node("h4", `${season.season} · Monthly league (UTC)`));
    const scores = node("table"),
      h = node("tr");
    for (const t of ["Player", "Mission / animal", "Matches", "Wins", "Points"])
      h.append(node("th", t));
    scores.append(h);
    for (const s of season.rows) {
      const r = node("tr");
      for (const t of [
        s.player_label,
        `${s.mission} / ${s.species}`,
        String(s.matches),
        String(s.wins),
        s.points,
      ])
        r.append(node("td", t));
      scores.append(r);
    }
    root.append(scores);
  }
}
$("leaderboard-refresh").onclick = () =>
  void refreshLeaderboard().catch((e) => message(readable(e)));
async function refreshJobs() {
  const p = await api<{ jobs: ExperienceJob[] }>("jobs");
  const root = $("experience-jobs");
  root.replaceChildren();
  for (const j of p.jobs)
    root.append(
      button(
        `${j.kind === "league" ? "Match" : "Experiment"} · ${j.status}`,
        () => {
          location.hash = j.kind === "league" ? "league" : "lab";
          void api<ExperienceJob>(`jobs/${j.id}`)
            .then(async (job) => {
              if (job.kind === "league") {
                clearArenas();
                await renderLeague(job);
              } else renderLab(job);
              schedulePoll();
            })
            .catch((e) => message(readable(e)));
        },
      ),
    );
  return p.jobs;
}
async function refreshJob(kind: "league" | "lab") {
  const current = kind === "league" ? league : lab;
  if (!current) return;
  const epoch = kind === "league" ? ++leagueEpoch : ++labEpoch;
  const j = await api<ExperienceJob>(`jobs/${current.id}`);
  if (
    epoch !== (kind === "league" ? leagueEpoch : labEpoch) ||
    (kind === "league" ? league : lab)?.id !== current.id
  )
    return;
  if (kind === "league") await renderLeague(j);
  else renderLab(j);
  if (j.status !== "running") void refreshLeaderboard().catch(() => undefined);
}
function schedulePoll() {
  if (poll) clearTimeout(poll);
  if (closed) return;
  poll = setTimeout(() => {
    void (async () => {
      try {
        if (league?.status === "running") await refreshJob("league");
        if (lab?.status === "running") await refreshJob("lab");
      } catch (e) {
        message(readable(e));
      } finally {
        if (league?.status === "running" || lab?.status === "running")
          schedulePoll();
      }
    })();
  }, 2000);
}

async function refreshMoments() {
  const p = await api<{ moments: ForestMoment[] }>("moments");
  const root = $("moment-cards");
  root.replaceChildren();
  if (!p.moments.length) {
    root.append(
      node(
        "p",
        "No major moments are retained yet. The forest is still writing its story.",
        "experience-card empty-state",
      ),
    );
    return;
  }
  for (const m of p.moments) {
    const c = node("article", "", "experience-card moment-card");
    c.append(
      node("span", worldDay(m.worldTime), "moment-time"),
      node("h3", m.title),
      node("p", m.detail),
      button(m.replay ? "Watch the recording" : "Open this story", () =>
        selectMoment(m),
      ),
    );
    root.append(c);
  }
}
function selectMoment(m: ForestMoment) {
  selectedMoment = m;
  $("moment-preview").hidden = false;
  $("moment-title").textContent = m.title;
  $("moment-detail").textContent = m.detail;
  momentReady = false;
  momentSession = crypto.randomUUID();
  const preview = new URL(forestUrl(m.actorId, m));
  preview.searchParams.set("experienceSession", momentSession);
  ($("moment-forest") as HTMLIFrameElement).src = preview.href;
  ($("moment-record") as HTMLButtonElement).disabled = true;
  $("moment-download").hidden = true;
  $("moment-source").textContent = m.replay
    ? "The preview follows the saved recording. Your clip captures the rendered replay."
    : "Story clip: the current forest scene accompanies this historical saved record; it does not reconstruct the event.";
  $("moment-feedback").textContent = "Preparing the forest preview…";
  $("moment-preview").scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
    block: "start",
  });
}
$("moments-refresh").onclick = () =>
  void refreshMoments().catch((e) => message(readable(e)));
$("moment-record").onclick = () => {
  if (!selectedMoment) return;
  ($("moment-record") as HTMLButtonElement).disabled = true;
  $("moment-stop").hidden = false;
  $("moment-feedback").textContent = "Recording 20 seconds of the forest…";
  ($("moment-forest") as HTMLIFrameElement).contentWindow?.postMessage(
    {
      type: "wildsentia:capture",
      session: momentSession,
      duration: 20,
      title: selectedMoment.title,
      caption: selectedMoment.detail,
      context: `${selectedMoment.replay ? "Saved replay" : "Historical story · forest now"} · ${worldDay(selectedMoment.worldTime)}`,
    },
    location.origin,
  );
};
$("moment-stop").onclick = () => {
  ($("moment-forest") as HTMLIFrameElement).contentWindow?.postMessage(
    { type: "wildsentia:cancel-capture" },
    location.origin,
  );
};
$("moment-share").onclick = () =>
  void (async () => {
    if (!selectedMoment) return;
    const u = new URL("/", location.origin);
    if (selectedMoment.actorId)
      u.hash = new URLSearchParams({
        animal: selectedMoment.actorId,
        ...(selectedMoment.replay
          ? { event: selectedMoment.id, kind: selectedMoment.replay }
          : {}),
      }).toString();
    await navigator.clipboard.writeText(
      `${selectedMoment.title}\n${selectedMoment.detail}\n${u.href}`,
    );
    $("moment-feedback").textContent = "Story link copied.";
  })().catch(() => {
    $("moment-feedback").textContent =
      "Clipboard unavailable. Open the forest story and copy its address.";
  });
addEventListener("message", (e) => {
  if (
    e.origin !== location.origin ||
    e.source !== ($("moment-forest") as HTMLIFrameElement).contentWindow ||
    !e.data ||
    typeof e.data.type !== "string"
  )
    return;
  if (e.data.session !== momentSession) return;
  if (e.data.type === "wildsentia:ready") {
    momentReady = true;
    ($("moment-record") as HTMLButtonElement).disabled = false;
    $("moment-feedback").textContent =
      "Preview ready. Make a clip when you are ready.";
  }
  if (e.data.type === "wildsentia:capture-error") {
    ($("moment-record") as HTMLButtonElement).disabled = !momentReady;
    $("moment-stop").hidden = true;
    $("moment-feedback").textContent =
      typeof e.data.message === "string"
        ? e.data.message
        : "Recording unavailable.";
  }
  if (
    e.data.type === "wildsentia:clip" &&
    e.data.bytes instanceof ArrayBuffer &&
    e.data.bytes.byteLength <= 20_000_000
  ) {
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    const mime =
      typeof e.data.mime === "string" && e.data.mime.startsWith("video/")
        ? e.data.mime
        : "video/webm";
    clipUrl = URL.createObjectURL(new Blob([e.data.bytes], { type: mime }));
    const a = $("moment-download") as HTMLAnchorElement;
    a.href = clipUrl;
    a.download = `wildsentia-${selectedMoment?.id ?? "moment"}.${mime.includes("mp4") ? "mp4" : "webm"}`;
    a.hidden = false;
    $("moment-stop").hidden = true;
    ($("moment-record") as HTMLButtonElement).disabled = false;
    $("moment-feedback").textContent = "Your clip is ready to download.";
  }
});

function chat(text: string, question = false) {
  const root = $("safari-transcript");
  root.append(node("p", text, `chat-line${question ? " question" : ""}`));
  while (root.children.length > 16) root.firstElementChild?.remove();
  root.scrollTop = root.scrollHeight;
}
function showAnswer(a: SafariAnswer, speak = true) {
  chat(a.answer);
  if (a.animalId && isAnimalLinkId(a.animalId)) {
    selectedAnimal = a.animalId;
    ($("safari-forest") as HTMLIFrameElement).contentWindow?.postMessage(
      { type: "wildsentia:follow", animalId: a.animalId },
      location.origin,
    );
  }
  if (
    speak &&
    ($("safari-speak") as HTMLInputElement).checked &&
    "speechSynthesis" in window
  ) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(a.answer);
    u.rate = 0.95;
    speechSynthesis.speak(u);
  }
}
async function askSafari(q: string) {
  if (!q.trim()) return;
  chat(q, true);
  const params = new URLSearchParams({
    q,
    ...(selectedAnimal ? { animal: selectedAnimal } : {}),
  });
  try {
    showAnswer(await api<SafariAnswer>(`safari?${params}`));
  } catch (e) {
    chat(readable(e));
  }
}
$("safari-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("safari-question") as HTMLInputElement;
  const q = input.value;
  input.value = "";
  void askSafari(q);
});
document
  .querySelectorAll<HTMLButtonElement>("[data-question]")
  .forEach((b) => (b.onclick = () => void askSafari(b.dataset.question!)));
$("safari-mic").onclick = () => voice.listen();
$("safari-live").onclick = () =>
  void voice
    .connect()
    .then(() => {
      $("safari-stop").hidden = false;
    })
    .catch((e) => ($("safari-voice-status").textContent = readable(e)));
$("safari-stop").onclick = () =>
  void voice.stop().then(() => ($("safari-stop").hidden = true));

async function refreshAnimals() {
  const r = await fetch("/api/animals", { cache: "no-store" });
  if (!r.ok) throw new Error("Saved forest unavailable.");
  const p = await r.json();
  const select = $("life-animal") as HTMLSelectElement;
  const old = select.value;
  select.replaceChildren();
  if (!Array.isArray(p.animals)) throw new Error("Animal list unavailable.");
  const animals = p.animals
    .filter(
      (a: unknown) =>
        a && typeof a === "object" && "id" in a && isAnimalLinkId(a.id),
    )
    .slice(0, 8000) as Array<{ id: string; speciesId: string }>;
  for (const a of animals)
    select.add(new Option(`${a.speciesId} · ${a.id}`, a.id));
  const chosen = new URLSearchParams(location.search).get("animal");
  if (chosen && animals.some((a) => a.id === chosen)) select.value = chosen;
  else if (old && animals.some((a) => a.id === old)) select.value = old;
}
function familyLink(id: string, label: string) {
  const a = node("a", label);
  a.href = `/#${new URLSearchParams({ animal: id })}`;
  return a;
}
async function refreshLives() {
  const p = await api<{ lives: FollowedLife[]; seenThrough: number }>(
    "follows",
  );
  seenThrough = p.seenThrough;
  const root = $("life-cards");
  root.replaceChildren();
  if (!p.lives.length) {
    root.append(
      node(
        "p",
        "Choose a life above. Its next chapter will be waiting here.",
        "experience-card empty-state",
      ),
    );
    return;
  }
  for (const l of p.lives) {
    const c = node("article", "", "experience-card moment-card");
    c.append(
      node(
        "span",
        l.alive === null
          ? "Outside retained checkpoint"
          : l.alive
            ? "Living"
            : "Remembered",
        "moment-time",
      ),
      node("h3", l.nickname || l.animalId),
      node("p", `${l.speciesId ?? "Recorded life"} · ${l.animalId}`),
    );
    if (l.unread) c.append(node("span", "New moments", "pill"));
    const family = node("div", "", "family-links");
    if (l.motherId) family.append(familyLink(l.motherId, "Mother"));
    if (l.fatherId) family.append(familyLink(l.fatherId, "Father"));
    l.offspringIds
      .slice(0, 10)
      .forEach((id, i) => family.append(familyLink(id, `Offspring ${i + 1}`)));
    c.append(family);
    for (const m of l.moments.slice(0, 3)) {
      c.append(node("p", m.detail));
      if (notifications && !notified.has(m.id)) {
        notified.add(m.id);
        if (l.unread && Notification.permission === "granted")
          new Notification(l.nickname || l.animalId, {
            body: m.detail.slice(0, 180),
            tag: m.id,
          });
      }
    }
    const actions = node("div", "", "actions");
    actions.append(
      familyLink(l.animalId, "Watch this life"),
      button(
        "Unfollow",
        () =>
          void api("follows/remove", { animalId: l.animalId })
            .then(refreshLives)
            .catch((e) => message(readable(e))),
      ),
    );
    c.append(actions);
    root.append(c);
  }
  while (notified.size > 300) notified.delete(notified.values().next().value!);
}
$("life-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  void busy(form, async () => {
    const f = new FormData(form);
    await api("follows", {
      animalId: f.get("animal"),
      nickname: String(f.get("nickname") ?? ""),
    });
    await refreshLives();
    message("This life is now in your list.");
  });
});
$("lives-refresh").onclick = () =>
  void refreshLives().catch((e) => message(readable(e)));
$("lives-seen").onclick = () =>
  void api("follows/seen", { sequence: seenThrough })
    .then(refreshLives)
    .catch((e) => message(readable(e)));
$("lives-notify").onclick = () =>
  void (async () => {
    if (!("Notification" in window)) {
      $("lives-notice").textContent =
        "Notifications are unavailable in this browser.";
      return;
    }
    if (notifications) {
      notifications = false;
      $("lives-notify").setAttribute("aria-pressed", "false");
      $("lives-notice").textContent = "Notifications stopped.";
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      $("lives-notice").textContent =
        "Notifications were not enabled. Your saved updates remain here.";
      return;
    }
    // Prime retained events before enabling so the first poll does not announce the old history.
    const p = await api<{ lives: FollowedLife[] }>("follows");
    p.lives.forEach((l) => l.moments.forEach((m) => notified.add(m.id)));
    notifications = true;
    $("lives-notify").setAttribute("aria-pressed", "true");
    $("lives-notice").textContent =
      "New saved moments can notify you while this page stays open.";
  })().catch((e) => ($("lives-notice").textContent = readable(e)));
function scheduleLives() {
  lifePoll = setTimeout(() => {
    if (tab === "lives" || notifications)
      void refreshLives().catch(() => undefined);
    if (!closed) scheduleLives();
  }, 30_000);
}

function chart(
  title: string,
  baseline: LabSample[],
  experiment: LabSample[],
  value: (s: LabSample) => number,
) {
  const card = node("article", "", "chart-card");
  card.append(node("h4", title));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 460 200");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `${title}: solid baseline and dashed experiment, days left to right`,
  );
  const all = [...baseline, ...experiment];
  const max = Math.max(1, ...all.map(value)),
    last = Math.max(1, ...all.map((s) => s.day));
  for (const [data, color, dash] of [
    [baseline, "var(--moss)", ""],
    [experiment, "var(--clay)", "6 5"],
  ] as const) {
    const path = document.createElementNS(svg.namespaceURI, "polyline");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "3");
    if (dash) path.setAttribute("stroke-dasharray", dash);
    path.setAttribute(
      "points",
      data
        .map(
          (s) => `${35 + (s.day / last) * 395},${160 - (value(s) / max) * 135}`,
        )
        .join(" "),
    );
    svg.append(path);
  }
  for (const [x, y, text] of [
    [10, 18, Math.round(max).toLocaleString()],
    [35, 188, "Day 0"],
    [390, 188, `Day ${last}`],
  ] as const) {
    const t = document.createElementNS(svg.namespaceURI, "text");
    t.setAttribute("x", String(x));
    t.setAttribute("y", String(y));
    t.setAttribute("fill", "var(--ink-2)");
    t.setAttribute("font-size", "12");
    t.textContent = text;
    svg.append(t);
  }
  card.append(svg);
  return card;
}
function renderLab(job: ExperienceJob) {
  lab = job;
  $("lab-output").hidden = false;
  $("lab-cancel").hidden = job.status !== "running";
  const result = job.result && "baseline" in job.result ? job.result : null;
  $("lab-progress").textContent = result
    ? `${result.completedDays} world days compared`
    : job.status === "running"
      ? `Computing · ${Math.round(job.progress.percent)}%`
      : (job.error?.replaceAll("_", " ") ?? job.status);
  ($("lab-meter") as HTMLProgressElement).value =
    job.status === "completed" ? 100 : job.progress.percent;
  const baseline = result?.baseline ?? job.progress.baseline ?? [],
    experiment = result?.experiment ?? job.progress.experiment ?? [];
  const charts = $("lab-charts");
  charts.replaceChildren(
    chart("Living animals", baseline, experiment, (s) =>
      Object.values(s.population).reduce((n, v) => n + v, 0),
    ),
    chart("Fresh water (litres)", baseline, experiment, (s) => s.waterL),
    chart("Vegetation (kg)", baseline, experiment, (s) => s.vegetationKg),
    chart("People alive", baseline, experiment, (s) => s.peopleAlive),
  );
  const root = $("lab-table");
  root.replaceChildren();
  if (baseline.length && experiment.length) {
    const a = baseline.at(-1)!,
      b = experiment.at(-1)!,
      table = node("table"),
      head = node("tr");
    for (const t of [
      "Measure",
      `Baseline day ${a.day}`,
      `Changed day ${b.day}`,
    ])
      head.append(node("th", t));
    table.append(head);
    for (const [label, x, y] of [
      ...Object.keys({ ...a.population, ...b.population })
        .sort()
        .map(
          (id) => [id, a.population[id] ?? 0, b.population[id] ?? 0] as const,
        ),
      ["Births", a.births, b.births] as const,
      ["Deaths", a.deaths, b.deaths] as const,
      ["Nutrient ledger", a.nutrients, b.nutrients] as const,
    ]) {
      const r = node("tr");
      r.append(
        node("th", label),
        node(
          "td",
          Number(x).toLocaleString(undefined, { maximumFractionDigits: 2 }),
        ),
        node(
          "td",
          Number(y).toLocaleString(undefined, { maximumFractionDigits: 2 }),
        ),
      );
      table.append(r);
    }
    root.append(table);
  }
  $("lab-assumptions").replaceChildren(
    ...(
      result?.assumptions ?? [
        "Each run uses a copy. The live forest keeps running.",
      ]
    ).map((s) => node("li", s)),
  );
  $("lab-export").hidden = !result;
}
$("lab-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  void busy(form, async () => {
    const f = new FormData(form);
    labEpoch++;
    lab = null;
    renderLab(
      await api<ExperienceJob>("lab", {
        scenario: f.get("scenario"),
        days: Number(f.get("days")),
      }),
    );
    schedulePoll();
    await refreshJobs();
  });
});
$("lab-cancel").onclick = () =>
  void (async () => {
    if (lab) {
      await api(`jobs/${lab.id}/cancel`, {});
      await refreshJob("lab");
    }
  })().catch((e) => message(readable(e)));
$("lab-export").onclick = () => {
  if (lab?.result)
    download(
      JSON.stringify(lab, null, 2),
      `wildsentia-experiment-${lab.id}.json`,
    );
};
addEventListener("pagehide", () => {
  closed = true;
  if (poll) clearTimeout(poll);
  if (lifePoll) clearTimeout(lifePoll);
  if (replayTimer) clearInterval(replayTimer);
  for (const c of cards.values()) c.view?.dispose();
  void voice.stop();
  if (clipUrl) URL.revokeObjectURL(clipUrl);
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
});
async function start() {
  // Issue the HttpOnly profile once before concurrent private reads or form actions.
  // Otherwise first-visit responses can each set a different owner cookie.
  const jobs = await refreshJobs();
  profileReady = true;
  const config = await api<{ models: LeaguePlayer[]; liveVoice: boolean }>(
    "info",
  );
  for (const id of ["league-first", "league-second"]) {
    const select = $(id) as HTMLSelectElement;
    for (const m of config.models)
      select.add(
        new Option(
          m.label + (m.source === "local" ? " · local strategy" : ""),
          m.id,
        ),
      );
  }
  ($("league-first") as HTMLSelectElement).value = "local:forager";
  ($("league-second") as HTMLSelectElement).value = "local:careful";
  $("safari-live").hidden = !config.liveVoice;
  const initial = await Promise.allSettled([
    refreshLeaderboard(),
    refreshAnimals(),
  ]);
  for (const r of initial)
    if (r.status === "rejected") message(readable(r.reason));
  document
    .querySelectorAll<HTMLButtonElement>(
      "#league-form button[type=submit], #life-form button[type=submit], #lab-form button[type=submit]",
    )
    .forEach((b) => (b.disabled = false));
  for (const item of jobs.filter((j) => j.status === "running")) {
    const job = await api<ExperienceJob>(`jobs/${item.id}`);
    if (job.kind === "league" && !league) await renderLeague(job);
    if (job.kind === "lab" && !lab) renderLab(job);
  }
  schedulePoll();
  scheduleLives();
  selectTab();
  chat(
    "Welcome to the island. Ask about an animal or let me show you a saved forest moment.",
  );
}
document
  .querySelectorAll<HTMLButtonElement>(
    "#league-form button[type=submit], #life-form button[type=submit], #lab-form button[type=submit]",
  )
  .forEach((b) => (b.disabled = true));
selectTab();
void start().catch((e) => message(readable(e)));

function syncViewerVisibility() {
  for (const [id, visible] of [
    ["safari-forest", tab === "safari"],
    ["moment-forest", tab === "moments"],
  ] as const)
    ($(`${id}`) as HTMLIFrameElement).contentWindow?.postMessage(
      { type: "wildsentia:visibility", visible: visible && !document.hidden },
      location.origin,
    );
}
addEventListener("visibilitychange", syncViewerVisibility);
for (const id of ["safari-forest", "moment-forest"])
  $(id).addEventListener("load", syncViewerVisibility);
const missionInput = document.querySelector<HTMLSelectElement>(
    "#league-form [name=mission]",
  )!,
  speciesInput = document.querySelector<HTMLSelectElement>(
    "#league-form [name=species]",
  )!;
missionInput.onchange = () => {
  for (const option of speciesInput.options)
    option.disabled =
      missionInput.value === "hunt" &&
      !["tiger", "leopard"].includes(option.value);
  if (speciesInput.selectedOptions[0]?.disabled) speciesInput.value = "tiger";
};
