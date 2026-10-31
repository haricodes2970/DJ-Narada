const $ = (id) => document.getElementById(id);

const metaToken = (document.querySelector('meta[name="narada-token"]')?.content ?? "").trim();
const token = metaToken.startsWith("__") ? "" : metaToken;

const AVATAR_FRAMES = [
  "/assets/avatar/frame1.png",
  "/assets/avatar/frame2.png",
  "/assets/avatar/frame3.png",
  "/assets/avatar/frame4.png",
];

const state = {
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
  lastScroll: 0,
};

const decks = [0, 1].map(() => ({ audio: new Audio(), gain: null, timer: 0 }));
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
  ctx = new AudioCtor();
  master = ctx.createGain();
  master.gain.value = state.volume / 100;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.72;
  master.connect(analyser);
  analyser.connect(ctx.destination);
  freq = new Uint8Array(analyser.frequencyBinCount);

  for (const deck of decks) {
    const source = ctx.createMediaElementSource(deck.audio);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(master);
    deck.gain = gain;
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
    if (!state.fading) void advance(true);
  });
  deck.audio.addEventListener("error", () => {
    if (index === activeDeck) toast("Cannot play this file");
  });
}
decks.forEach(bindDeck);

/* ---------------- playback ---------------- */

async function playIndex(index, { fadeMs = 0 } = {}) {
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
    previous.timer = window.setTimeout(() => stopDeck(previous), fadeMs + 60);
  } else {
    if (previous.gain !== null) previous.gain.gain.value = 0;
    previous.timer = window.setTimeout(() => stopDeck(previous), 40);
    if (next.gain !== null) next.gain.gain.value = 1;
  }

  activeDeck = nextIndex;
  renderNowPlaying(track);
  renderQueue();
  syncTransport();
  updateProgress();
  updateMediaSession(track);
}

function maybeCrossfade() {
  if (!state.playing || state.fading || state.queue.length < 2 || state.xfade <= 0) return;
  const audio = decks[activeDeck].audio;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const remaining = audio.duration - audio.currentTime;
  if (remaining > state.xfade || remaining <= 0.05) return;

  state.fading = true;
  const nextIndex = pickNextIndex();
  void playIndex(nextIndex, { fadeMs: state.xfade * 1000 }).finally(() => {
    window.setTimeout(() => { state.fading = false; }, state.xfade * 1000 + 120);
  });
}

function pickNextIndex() {
  const count = state.queue.length;
  if (count <= 1) return 0;
  const current = state.queue[state.index];
  const cooldown = Math.min(6, count - 1);
  const blocked = new Set(state.recent.slice(-cooldown));
  const pool = [];
  for (let i = 0; i < count; i += 1) {
    if (i === state.index || blocked.has(i)) continue;
    const candidate = state.queue[i];
    if (count > 6 && current?.artist !== undefined && candidate.artist === current.artist) continue;
    pool.push(i);
  }
  const candidates = pool.length > 0 ? pool : state.queue.map((_, i) => i).filter((i) => i !== state.index);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  state.recent.push(chosen);
  while (state.recent.length > 10) state.recent.shift();
  return chosen;
}

async function advance(shuffle = true) {
  if (state.queue.length === 0) return;
  const nextIndex = shuffle ? pickNextIndex() : (state.index + 1) % state.queue.length;
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
  if (ctx.state === "suspended") await ctx.resume();

  if (state.playing) {
    decks[activeDeck].audio.pause();
    state.playing = false;
    syncTransport();
    return;
  }

  if (state.index < 0) {
    if (state.queue.length > 0) await playIndex(0);
    return;
  }

  const audio = decks[activeDeck].audio;
  if (!audio.src) {
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
    row.innerHTML = "";
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
  if (state.queue.length > 0) {
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

function wire() {
  $("enter").addEventListener("click", () => { void enter(); });
  document.addEventListener("keydown", (event) => {
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
  });

  $("play").addEventListener("click", () => { void togglePlay(); });
  $("next").addEventListener("click", () => { void advance(); });
  $("prev").addEventListener("click", () => { void previous(); });

  $("seek").addEventListener("input", (event) => {
    const audio = decks[activeDeck].audio;
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = (Number(event.target.value) / 1000) * audio.duration;
  });

  $("volume").value = String(state.volume);
  $("volume-value").textContent = String(state.volume);
  $("volume").addEventListener("input", (event) => {
    state.volume = Number(event.target.value);
    localStorage.setItem("narada.volume", String(state.volume));
    $("volume-value").textContent = String(state.volume);
    if (master !== null) master.gain.value = state.volume / 100;
  });

  $("xfade").value = String(state.xfade);
  $("xfade-value").textContent = `${state.xfade}s`;
  $("xfade").addEventListener("input", (event) => {
    state.xfade = Number(event.target.value);
    localStorage.setItem("narada.xfade", String(state.xfade));
    $("xfade-value").textContent = `${state.xfade}s`;
  });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".tab")) other.classList.toggle("is-active", other === tab);
      const name = tab.dataset.tab;
      $("panel-categories").hidden = name !== "categories";
      $("panel-queue").hidden = name !== "queue";
    });
  }
}

async function enter() {
  ensureAudio();
  if (ctx.state === "suspended") await ctx.resume();

  $("landing").hidden = true;
  $("radio").hidden = false;

  try {
    await loadLibrary();
  } catch (error) {
    toast(`Library unavailable: ${error.message}`);
    return;
  }

  const categories = state.library.categories;
  const remembered = categories.find((category) => category.id === state.categoryId);
  const fallback = categories.find((category) => category.id !== "__all__" && category.trackCount > 0) ?? categories[0];
  const target = remembered ?? fallback;
  if (target !== undefined) await selectCategory(target.id);
  syncTransport();
}

async function bootstrap() {
  wire();
  startAvatarLoop();
  drawSpectrum();
  $("enter").disabled = true;
  try {
    const health = await api("/api/health");
    $("landing-meta").textContent = `LOCAL RADIO · ${health.tracks} TRACKS · ${health.categories} CATEGORIES`;
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
