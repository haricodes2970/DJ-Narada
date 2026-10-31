const $ = (id) => document.getElementById(id);

const metaToken = (document.querySelector('meta[name="narada-token"]')?.content ?? "").trim();
const token = metaToken.startsWith("__") ? "" : metaToken;

const AVATAR_FRAMES = [
  "/assets/avatar/frame1.png",
  "/assets/avatar/frame2.png",
  "/assets/avatar/frame3.png",
  "/assets/avatar/frame4.png",
];

const MODES = ["dj", "fm", "manual"];

const state = {
  mode: localStorage.getItem("narada.mode") ?? "dj",
  library: null,
  queue: [],
  index: -1,
  categoryId: localStorage.getItem("narada.category") ?? null,
  playing: false,
  fading: false,
  volume: Number(localStorage.getItem("narada.volume") ?? 70),
  xfade: Number(localStorage.getItem("narada.xfade") ?? 4),
  recent: [],
  frame: 0,
  dj: { arc: 0.12 },
  transitions: [],
  stingerGain: null,
};

const decks = [0, 1].map(() => ({ audio: new Audio(), gain: null, bass: null, send: null, delay: null, timer: 0 }));
const stinger = new Audio();
let activeDeck = 0;
let ctx = null;
let master = null;
let analyser = null;
let freq = null;

function apiHeaders(extra = {}) {
  const headers = { ...extra };
  if (token.length > 0) headers["x-narada-token"] = token;
  return headers;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: apiHeaders(options.headers) });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).error ?? detail;
    } catch {
      /* keep status text */
    }
    throw new Error(`${response.status} ${detail}`);
  }
  return response.json();
}

function audioUrl(track) {
  const query = new URLSearchParams({ path: track.path });
  if (token.length > 0) query.set("token", token);
  return `/api/audio?${query.toString()}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

let toastTimer;
function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { node.hidden = true; }, 3200);
}

/* ---------------- audio graph ---------------- */

function ensureAudio() {
  if (ctx !== null) return;
  const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioCtor) return;
  ctx = new AudioCtor();
  master = ctx.createGain();
  master.gain.value = state.volume / 100;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.72;
  master.connect(analyser);
  analyser.connect(ctx.destination);
  freq = new Uint8Array(analyser.frequencyBinCount);

  const stingerGain = ctx.createGain();
  stingerGain.gain.value = 1;
  const stingerSource = ctx.createMediaElementSource(stinger);
  stingerSource.connect(stingerGain);
  stingerGain.connect(master);
  state.stingerGain = stingerGain;

  for (const deck of decks) {
    const source = ctx.createMediaElementSource(deck.audio);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    /* Bass EQ per deck — the producer engine swaps bass at the handoff. */
    const bass = ctx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 240;
    bass.gain.value = 0;
    source.connect(gain);
    gain.connect(bass);
    bass.connect(master);
    deck.gain = gain;
    deck.bass = bass;

    /* Echo send — "echo out" transitions: outgoing track rings into the
       delay tail while the incoming track takes over underneath. */
    const send = ctx.createGain();
    send.gain.value = 0;
    const delay = ctx.createDelay(3);
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    gain.connect(send);
    send.connect(delay);
    delay.connect(master);
    delay.connect(feedback);
    feedback.connect(delay);
    deck.send = send;
    deck.delay = delay;
  }
}

function ramp(param, value, ms) {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  if (ms <= 0) param.setValueAtTime(value, now);
  else param.linearRampToValueAtTime(value, now + ms / 1000);
}

function stopDeck(deck) {
  window.clearTimeout(deck.timer);
  deck.audio.pause();
  deck.audio.removeAttribute("src");
  deck.audio.load();
  if (deck.gain !== null) deck.gain.gain.value = 0;
  if (deck.bass !== null) deck.bass.gain.value = 0;
  if (deck.send !== null) deck.send.gain.value = 0;
}

function bindDeck(deck, index) {
  deck.audio.addEventListener("timeupdate", () => {
    if (index !== activeDeck) return;
    maybeCrossfade();
    updateProgress();
  });
  deck.audio.addEventListener("loadedmetadata", () => {
    if (index === activeDeck) updateProgress();
  });
  deck.audio.addEventListener("ended", () => {
    if (index !== activeDeck || !state.playing) return;
    if (!state.fading) void advance();
  });
  deck.audio.addEventListener("error", () => {
    if (index === activeDeck) toast("Cannot play this file");
  });
}
decks.forEach(bindDeck);

/* The stinger clip is awaited inside playTransition — no global listeners,
   otherwise the clip end re-triggers playNextRandom and every track gets
   chopped after ~2 seconds. */

/* ---------------- queue + randomization ---------------- */

function shuffleQueue(source) {
  const result = [...source];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/* Fisher-Yates shuffle gives a different order every time DJ mode starts. */
function enterDJMode() {
  const source = state.queue.length > 0 ? state.queue : (state.library?.tracks ?? []);
  state.queue = shuffleQueue(source);
  state.index = -1;
  state.recent = [];
  renderQueue();
  if (state.queue.length > 0) {
    void playIndex(0, { fadeMs: 300 });
  } else {
    state.playing = false;
    syncTransport();
    toast("No tracks in DJ queue");
  }
}

/* ---------------- DJ producer engine ----------------
   Technique selection follows real DJ practice:
   - |ΔBPM| ≤ 5   → smooth blend, bass swap at the handoff
   - 5 < |ΔBPM| ≤ 12 → echo out: outgoing tail rings while next lands
   - |ΔBPM| > 12 / unknown → radio drop (stinger clip / hard crossfade)
   Track choice scores BPM compatibility + an energy arc so sets breathe
   instead of maxing out. */

const BLEND_BEAT_MS = () => {
  /* Quarter-note length for blend math; 122 BPM default when unknown. */
  return 60 / 122 * 1000;
};

function techniqueFor(current, next) {
  const bpmA = Number(current?.bpm);
  const bpmB = Number(next?.bpm);
  if (!Number.isFinite(bpmA) || !Number.isFinite(bpmB) || bpmA <= 0 || bpmB <= 0) {
    return state.transitions.length > 0 ? "drop" : "blend";
  }
  const delta = Math.abs(bpmA - bpmB);
  if (delta <= 5) return "blend";
  if (delta <= 12) return "echo";
  return "drop";
}

function pickNextTrack(currentTrack) {
  const count = state.queue.length;
  if (count === 1) return 0;

  const cooldown = Math.min(6, count - 1);
  const blocked = new Set(state.recent.slice(-cooldown));
  const pool = [];
  for (let i = 0; i < count; i += 1) {
    if (i === state.index || blocked.has(i)) continue;
    const candidate = state.queue[i];
    if (count > 6 && currentTrack?.artist !== undefined && candidate.artist === currentTrack.artist) continue;
    pool.push(i);
  }
  const fallbackPool = pool.length > 0 ? pool : state.queue.map((_, i) => i).filter((i) => i !== state.index);

  const targetEnergy = Number(currentTrack?.energy);
  const bpmA = Number(currentTrack?.bpm);
  const scored = fallbackPool.map((index) => {
    const track = state.queue[index];
    let energyScore = 0;
    if (Number.isFinite(targetEnergy) && Number.isFinite(Number(track.energy))) {
      /* Arc keep alive: drift toward or away from the current energy. */
      const goal = Math.max(0.05, Math.min(1, targetEnergy + state.dj.arc));
      energyScore = 1 - Math.abs(track.energy - goal);
    }
    let bpmScore = 0;
    if (Number.isFinite(bpmA) && Number.isFinite(Number(track.bpm)) && bpmA > 0 && track.bpm > 0) {
      bpmScore = Math.max(0, 1 - Math.abs(bpmA - track.bpm) / 40);
    }
    return { index, score: energyScore * 0.45 + bpmScore * 0.3 + Math.random() * 0.25 };
  });
  scored.sort((a, b) => b.score - a.score);
  const shortlist = scored.slice(0, Math.min(3, scored.length));
  const chosen = shortlist[Math.floor(Math.random() * shortlist.length)].index;

  state.recent.push(chosen);
  while (state.recent.length > 10) state.recent.shift();

  /* Flip the arc occasionally so the set settles as well as lifts. */
  if (Math.random() < 0.2) state.dj.arc = -state.dj.arc;

  return chosen;
}

async function playNextRandom() {
  if (state.queue.length === 0) return;
  if (state.fading) return;

  const currentTrack = state.queue[state.index] ?? null;
  const chosen = pickNextTrack(currentTrack);
  if (state.queue.length === 1) {
    await playIndex(0, { fadeMs: 900 });
    return;
  }

  const nextTrack = state.queue[chosen];
  const style = techniqueFor(currentTrack, nextTrack);

  if (style === "drop" && state.transitions.length > 0) {
    state.fading = true;
    const transition = state.transitions[Math.floor(Math.random() * state.transitions.length)];
    await playTransition(transition.path, transition.name);
    state.fading = false;
    await playIndex(chosen, { fadeMs: 900 });
    return;
  }

  if (style === "echo") {
    state.fading = true;
    const tail = echoOut(decks[activeDeck], Number(currentTrack?.bpm));
    await new Promise((resolve) => window.setTimeout(resolve, tail * 1000 + 900));
    const outgoing = decks[activeDeck];
    stopDeck(outgoing);
    state.fading = false;
    await playIndex(chosen, { fadeMs: 500 });
    toast(`🎚️ echo out → ${nextTrack.title}`);
    return;
  }

  /* Smooth blend, stretched and aligned to musical bars when BPM is known. */
  state.fading = true;
  const bpm = Number(currentTrack?.bpm);
  const barMs = Number.isFinite(bpm) && bpm > 30 ? (60 / bpm) * 4 * 1000 : BLEND_BEAT_MS() * 4;
  const bars = Number.isFinite(bpm) && bpm > 30 ? 8 : 2;
  const fadeMs = Math.min(12000, Math.max(state.xfade * 1000, barMs * bars, 2000));
  state.fading = false;
  await playIndex(chosen, { fadeMs, blend: true });
}

/* Echo out: route the outgoing deck into its delay, duck the dry gain and
   let the tail ring for ~3 steps. Returns tail length in seconds. */
function echoOut(deck, bpm) {
  const step = Number.isFinite(bpm) && bpm > 30 ? Math.min(1.5, 60 / bpm) : 0.5;
  if (deck.delay !== null && deck.send !== null) {
    deck.delay.delayTime.value = step / 2;
    const now = ctx.currentTime;
    deck.send.gain.cancelScheduledValues(now);
    deck.send.gain.setValueAtTime(0, now);
    deck.send.gain.linearRampToValueAtTime(0.85, now + 0.06);
    ramp(deck.gain.gain, 0, step * 1000);
  } else if (deck.gain !== null) {
    ramp(deck.gain.gain, 0, step * 1000);
  }
  deck.timer = window.setTimeout(() => stopDeck(deck), step * 1000 * 3);
  return step * 2;
}

/* ---------------- transitions ---------------- */

async function loadTransitions() {
  try {
    const data = await api("/api/dj/transitions");
    state.transitions = data.transitions ?? [];
    toast(`${state.transitions.length} DJ transitions loaded`);
  } catch {
    state.transitions = [];
  }
}

/* Stinger playback that resolves only when the clip has actually FINISHED
   (or failed). Transitions are fire-and-wait — the next track starts after
   the drop, never on top of it. Safety timeout guards against a clip that
   never fires `ended` (e.g. browser throttling). */
function playStingerClip(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(safety);
      stinger.removeEventListener("ended", finish);
      stinger.removeEventListener("error", finish);
      resolve();
    };
    const safety = window.setTimeout(finish, 15000);
    stinger.addEventListener("ended", finish);
    stinger.addEventListener("error", finish);
    stinger.src = url + (token.length > 0 ? `?token=${token}` : "");
    stinger.load();
    stinger.play().catch(finish);
  });
}

async function playTransition(url, label) {
  ensureAudio();
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch { /* retried by playIndex */ }
  }

  /* Fade the outgoing deck under the drop, then let it end. */
  const previous = decks[activeDeck];
  if (previous.gain !== null) ramp(previous.gain.gain, 0, 700);
  window.clearTimeout(previous.timer);
  previous.timer = window.setTimeout(() => stopDeck(previous), 760);

  await playStingerClip(url);
  stopDeck(previous);
  toast(`🎙️ ${label}`);
}

/* ---------------- playback ---------------- */

async function playIndex(index, { fadeMs = 0, blend = false } = {}) {
  const track = state.queue[index];
  if (track === undefined) return;
  ensureAudio();
  if (ctx.state === "suspended") await ctx.resume();

  state.index = index;
  state.playing = true;

  const previousIndex = activeDeck;
  const nextIndex = activeDeck ^ 1;
  const previous = decks[previousIndex];
  const next = decks[nextIndex];

  window.clearTimeout(previous.timer);
  window.clearTimeout(next.timer);

  next.audio.src = audioUrl(track);
  next.audio.load();
  try {
    await next.audio.play();
  } catch {
    state.playing = false;
    syncTransport();
    toast("Browser blocked audio — press play once");
    return;
  }

  const overlap = fadeMs > 0 && !previous.audio.paused && previous.gain !== null && next.gain !== null;
  if (overlap) {
    ramp(next.gain.gain, 1, fadeMs);
    ramp(previous.gain.gain, 0, fadeMs);
    if (options.blend === true) {
      /* Bass swap: incoming low are cut while both play, then swap －
         two bass lines at once sound like mud (EQ mixing principle). */
      if (next.bass !== null) next.bass.gain.value = -30;
      if (previous.bass !== null) ramp(previous.bass.gain, -34, fadeMs * 0.5);
      window.setTimeout(() => {
        if (next.bass !== null) ramp(next.bass.gain, 0, Math.max(40, fadeMs * 0.45));
      }, fadeMs * 0.45);
    }
    previous.timer = window.setTimeout(() => stopDeck(previous), fadeMs + 60);
  } else {
    if (previous.gain !== null) previous.gain.gain.value = 0;
    previous.timer = window.setTimeout(() => stopDeck(previous), 40);
    if (next.gain !== null) next.gain.gain.value = 1;
    if (next.bass !== null) next.bass.gain.value = 0;
  }

  activeDeck = nextIndex;
  renderNowPlaying(track);
  renderQueue();
  syncTransport();
  updateProgress();
  updateMediaSession(track);
}

function maybeCrossfade() {
  if (state.mode !== "dj" || !state.playing || state.fading || state.queue.length < 2 || state.xfade <= 0)
    return;
  const audio = decks[activeDeck].audio;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const remaining = audio.duration - audio.currentTime;
  if (remaining > state.xfade || remaining <= 0.05) return;

  state.fading = true;
  void playNextRandom().finally(() => {
    window.setTimeout(() => { state.fading = false; }, state.xfade * 1000 + 120);
  });
}

async function advance(shuffle = true) {
  if (state.queue.length === 0 || state.fading) return;
  if (state.mode === "dj") {
    void playNextRandom();
    return;
  }
  const nextIndex = shuffle ? (state.index + 1) % state.queue.length : (state.index + 1) % state.queue.length;
  await playIndex(nextIndex, { fadeMs: 1200 });
}

async function previous() {
  if (state.queue.length === 0) return;
  const audio = decks[activeDeck].audio;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  await playIndex((state.index - 1 + state.queue.length) % state.queue.length, { fadeMs: 900 });
}

async function togglePlay() {
  ensureAudio();
  try {
    if (ctx.state === "suspended") await ctx.resume();
  } catch {
    toast("Audio needs a user gesture — click Play again");
    return;
  }

  if (state.playing) {
    decks[activeDeck].audio.pause();
    state.playing = false;
    syncTransport();
    return;
  }

  if (state.index < 0) {
    if (state.mode === "dj") {
      void enterDJMode();
      return;
    }
    if (state.queue.length > 0) await playIndex(0);
    return;
  }

  const audio = decks[activeDeck].audio;
  if (!audio.src) {
    if (state.mode === "dj") {
      void enterDJMode();
      return;
    }
    await playIndex(state.index);
    return;
  }
  await audio.play();
  state.playing = true;
  syncTransport();
}

/* ---------------- rendering ---------------- */

function renderNowPlaying(track) {
  $("np-artist").textContent = track.artist ?? "Unknown artist";
  $("np-title").textContent = track.title;
  $("np-album").textContent = [track.album, track.format?.toUpperCase()].filter(Boolean).join(" · ");
  $("stage-title").textContent = track.title;
  $("stage-artist").textContent = track.artist ?? "Unknown";
  document.title = `${track.title} — Narada DJ`;
}

function renderCategories() {
  const host = $("categories");
  host.replaceChildren();
  if (state.library === null) return;

  for (const category of state.library.categories) {
    const row = document.createElement("div");
    row.className = `row${category.id === state.categoryId ? " is-active" : ""}`;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `${category.name}, ${category.trackCount} tracks`);

    const star = document.createElement("button");
    star.type = "button";
    star.className = `row__star${category.starred ? " is-starred" : ""}`;
    star.textContent = category.starred ? "★" : "☆";
    star.disabled = category.id === "__all__";
    star.setAttribute("aria-label", `${category.starred ? "Unstar" : "Star"} ${category.name}`);
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      void toggleStar(category);
    });

    const name = document.createElement("span");
    name.className = "row__name";
    name.textContent = category.name;

    const count = document.createElement("span");
    count.className = "row__count";
    count.textContent = String(category.trackCount);

    row.append(star, name, count);
    row.addEventListener("click", () => { void selectCategory(category.id); });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void selectCategory(category.id);
      }
    });
    host.append(row);
  }
}

function renderQueue() {
  const host = $("queue");
  host.replaceChildren();
  if (state.queue.length === 0) {
    host.innerHTML = '<p class="empty">Queue is empty</p>';
    return;
  }
  const start = Math.max(0, state.index);
  const items = state.queue.slice(start, start + 40);
  items.forEach((track, offset) => {
    const index = start + offset;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `row row--track${index === state.index ? " is-current" : ""}`;
    const number = document.createElement("span");
    number.className = "row__index";
    number.textContent = index === state.index ? "▶" : String(index + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "row__name";
    name.textContent = track.title;
    const time = document.createElement("span");
    time.className = "row__count";
    time.textContent = formatTime(track.durationSeconds ?? 0);
    row.append(number, name, time);
    row.addEventListener("click", () => { void playIndex(index, { fadeMs: 700 }); });
    host.append(row);
  });
}

function syncTransport() {
  const modeBtn = $("mode");
  modeBtn.className = `btn btn--mode${state.mode === "dj" ? " is-dj" : state.mode === "manual" ? " is-manual" : ""}`;
  modeBtn.textContent = state.mode.toUpperCase();
  modeBtn.setAttribute("aria-label", `${state.mode} mode`);
  $("play").textContent = state.playing ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", state.playing ? "Pause" : "Play");
  $("stage-badge").textContent = state.playing ? "ON AIR" : "STANDBY";
}

function updateProgress() {
  const audio = decks[activeDeck].audio;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const ratio = duration > 0 ? Math.min(1, position / duration) : 0;

  $("progress-fill").style.width = `${(ratio * 100).toFixed(2)}%`;
  $("t-cur").textContent = formatTime(position);
  $("t-dur").textContent = formatTime(duration);
  $("seek-cur").textContent = formatTime(position);
  $("seek-dur").textContent = formatTime(duration);

  const seek = $("seek");
  if (document.activeElement !== seek) seek.value = String(Math.round(ratio * 1000));
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;
  if (typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist ?? "Narada DJ",
    album: track.album ?? "Local library",
    artwork: [{ src: "/assets/avatar/frame1.png", sizes: "272x362", type: "image/png" }],
  });
  navigator.mediaSession.setActionHandler("play", () => { void togglePlay(); });
  navigator.mediaSession.setActionHandler("pause", () => { void togglePlay(); });
  navigator.mediaSession.setActionHandler("nexttrack", () => { void advance(); });
  navigator.mediaSession.setActionHandler("previoustrack", () => { void previous(); });
}

/* ---------------- data ---------------- */

async function loadLibrary() {
  const data = await api("/api/library");
  state.library = data;
  renderCategories();
}

async function selectCategory(id) {
  state.categoryId = id;
  localStorage.setItem("narada.category", id);
  const data = await api(`/api/tracks?category=${encodeURIComponent(id)}`);
  state.queue = data.tracks;
  state.index = -1;
  state.recent = [];
  renderCategories();
  renderQueue();
  if (state.mode === "dj") {
    void enterDJMode();
  } else if (state.queue.length > 0) {
    await playIndex(0, { fadeMs: 500 });
  } else {
    state.playing = false;
    syncTransport();
    toast("This category has no tracks yet");
  }
}

async function toggleStar(category) {
  try {
    const result = await api("/api/stars", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: category.path }),
    });
    await loadLibrary();
    toast(`${result.starred ? "Starred" : "Unstarred"} ${category.name}`);
  } catch (error) {
    toast(`Star failed: ${error.message}`);
  }
}

/* ---------------- visuals ---------------- */

const canvas = $("spectrum");
const canvasCtx = canvas.getContext("2d");

function drawSpectrum() {
  const width = canvas.width;
  const height = canvas.height;
  canvasCtx.clearRect(0, 0, width, height);

  if (analyser !== null) analyser.getByteFrequencyData(freq);

  const bars = 44;
  const gap = 3;
  const barWidth = Math.floor((width - gap * (bars - 1)) / bars);
  let lowEnergy = 0;

  for (let i = 0; i < bars; i += 1) {
    const sample = analyser === null ? 0 : freq[Math.floor((i / bars) * freq.length)] ?? 0;
    const level = Math.max(2, Math.round((sample / 255) * height));
    if (i < 6) lowEnergy += sample;
    const x = i * (barWidth + gap);
    const y = height - level;

    const color = i < bars * 0.45 ? "#ff7a2f" : i < bars * 0.75 ? "#ffc857" : "#4fd1c5";
    canvasCtx.fillStyle = color;
    canvasCtx.fillRect(x, y, barWidth, level);

    canvasCtx.fillStyle = "rgba(0,0,0,0.35)";
    for (let block = y + 3; block < height; block += 4) canvasCtx.fillRect(x, block, barWidth, 1);
  }

  const beat = lowEnergy / 6 > 96;
  $("avatar").dataset.beat = beat ? "1" : "0";

  window.requestAnimationFrame(drawSpectrum);
}

function startAvatarLoop() {
  let ticks = 0;
  window.setInterval(() => {
    ticks += 1;
    const every = state.playing ? 1 : 4;
    if (ticks % every !== 0) return;
    state.frame = (state.frame + 1) % 4;
    $("avatar-img").src = AVATAR_FRAMES[state.frame];
  }, 190);
}

/* ---------------- wiring ---------------- */

function safeListen(el, event, handler) {
  if (!el) return;
  try { el.addEventListener(event, handler); } catch { /* listener may already exist */ }
}

function wire() {
  const enterBtn = $("enter");
  safeListen(enterBtn, "click", () => { void enter(); });
  window.__naradaEnter = enter;

  safeListen(document, "keydown", (event) => {
    if (!$("landing").hidden && event.key === "Enter") {
      event.preventDefault();
      void enter();
      return;
    }
    if ($("radio").hidden) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT") return;
    if (event.key === " ") { event.preventDefault(); void togglePlay(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); void advance(); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); void previous(); }
    else if (event.key === "m" || event.key === "M") { event.preventDefault(); void cycleMode(); }
  });

  safeListen($("mode"), "click", () => { void cycleMode(); });
  safeListen($("play"), "click", () => { void togglePlay(); });
  safeListen($("next"), "click", () => { void advance(); });
  safeListen($("prev"), "click", () => { void previous(); });

  safeListen($("seek"), "input", (event) => {
    const audio = decks[activeDeck].audio;
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = (Number(event.target.value) / 1000) * audio.duration;
  });

  const volumeInput = $("volume");
  safeListen(volumeInput, "input", (event) => {
    state.volume = Number(event.target.value);
    localStorage.setItem("narada.volume", String(state.volume));
    $("volume-value").textContent = String(state.volume);
    if (master !== null) master.gain.value = state.volume / 100;
  });
  if (volumeInput) volumeInput.value = String(state.volume);
  $("volume-value").textContent = String(state.volume);

  const xfadeInput = $("xfade");
  safeListen(xfadeInput, "input", (event) => {
    state.xfade = Number(event.target.value);
    localStorage.setItem("narada.xfade", String(state.xfade));
    $("xfade-value").textContent = `${state.xfade}s`;
  });
  if (xfadeInput) xfadeInput.value = String(state.xfade);
  $("xfade-value").textContent = `${state.xfade}s`;

  for (const tab of document.querySelectorAll(".tab")) {
    safeListen(tab, "click", () => {
      for (const other of document.querySelectorAll(".tab")) other.classList.toggle("is-active", other === tab);
      const name = tab.dataset.tab;
      $("panel-categories").hidden = name !== "categories";
      $("panel-queue").hidden = name !== "queue";
    });
  }
}

async function cycleMode() {
  const current = MODES.indexOf(state.mode);
  const next = MODES[(current + 1) % MODES.length];
  state.mode = next;
  localStorage.setItem("narada.mode", state.mode);
  syncTransport();

  if (state.mode === "dj") {
    void enterDJMode();
    toast("DJ MODE — shuffled session started");
  } else if (state.mode === "manual") {
    state.playing = false;
    syncTransport();
    toast("MANUAL MODE — pick any track");
  } else {
    toast("FM MODE — coming soon");
  }
}

async function loadRandomLandingTrack() {
  try {
    const data = await api("/api/tracks");
    const tracks = data.tracks ?? [];
    if (tracks.length === 0) return;
    const track = tracks[Math.floor(Math.random() * tracks.length)];
    $("landing-artist").textContent = track.artist ?? "Unknown artist";
    $("landing-title").textContent = track.title;
    const art = $("landing-art");
    art.replaceChildren();
    const img = document.createElement("img");
    img.src = "/assets/avatar/frame1.png";
    img.alt = "Now";
    img.draggable = false;
    art.append(img);
  } catch {
    // Silent — landing still works without a featured track
  }
}

async function enter() {
  /* Switch pages FIRST — never gate navigation on audio state */
  $("landing").hidden = true;
  $("radio").hidden = false;

  ensureAudio();
  if (ctx && ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* No gesture yet — retried when the user presses play */
    }
  }

  try {
    await Promise.all([loadLibrary(), loadTransitions()]);
  } catch (error) {
    toast(`Library unavailable: ${error.message}`);
  }

  try {
    const categories = state.library?.categories ?? [];
    const remembered = categories.find((category) => category.id === state.categoryId);
    const fallback = categories.find((category) => category.id !== "__all__" && category.trackCount > 0) ?? categories[0];
    const target = remembered ?? fallback;
    if (target !== undefined) await selectCategory(target.id);
    syncTransport();
  } catch (error) {
    toast(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function bootstrap() {
  wire();
  startAvatarLoop();
  drawSpectrum();
  $("enter").disabled = true;
  try {
    const health = await api("/api/health");
    $("landing-meta").textContent = `LOCAL RADIO · ${health.tracks} TRACKS · ${health.categories} CATEGORIES`;
    await loadRandomLandingTrack();
  } catch (error) {
    $("landing-meta").textContent = "SERVICE OFFLINE — is narada running?";
    toast(`Service error: ${error.message}`);
  } finally {
    $("enter").disabled = false;
  }
}

void bootstrap();

// Deep-link for screenshots and kiosk launches: /?autostart=1
if (new URLSearchParams(location.search).has("autostart")) {
  $("enter").disabled = false;
  void enter();
}
