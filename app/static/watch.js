const grid = document.querySelector("#grid");
const emptyState = document.querySelector("#emptyState");
const statusEl = document.querySelector("#status");

let socket = null;
let reconnectDelay = 500;
const players = new Map();
const LIVE_EDGE_MARGIN_SECONDS = 0.35;
const MAX_LIVE_DELAY_SECONDS = 1.5;
const BUFFER_RETAIN_SECONDS = 4;

function setStatus(message) {
  statusEl.textContent = message;
}

function websocketUrl(path) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

function updateEmptyState() {
  emptyState.classList.toggle("hidden", players.size > 0);
}

function iconButton(className, title, pathData) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathData}</svg>`;
  return button;
}

function createPlayer(stream) {
  if (players.has(stream.streamId)) {
    return players.get(stream.streamId);
  }

  const tile = document.createElement("article");
  tile.className = "tile";
  tile.dataset.streamId = stream.streamId;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.controls = false;
  video.muted = true;

  const bar = document.createElement("div");
  bar.className = "tile-bar";

  const muteButton = iconButton("mute-button", "Unmute", mutedIcon());
  const expandButton = iconButton("expand-button", "Expand", '<path d="M15 3h6v6"></path><path d="M21 3l-7 7"></path><path d="M9 21H3v-6"></path><path d="M3 21l7-7"></path>');
  const closeButton = iconButton("close-button", "Close", '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>');

  muteButton.addEventListener("click", () => toggleMute(stream.streamId));
  expandButton.addEventListener("click", () => tile.classList.add("fullscreen"));
  closeButton.addEventListener("click", () => tile.classList.remove("fullscreen"));

  bar.append(muteButton, expandButton, closeButton);
  tile.append(video, bar);
  grid.append(tile);

  const player = {
    stream,
    tile,
    video,
    muteButton,
    mediaSource: null,
    sourceBuffer: null,
    queue: [],
    pendingCleanup: false,
    objectUrl: null,
    opened: false
  };
  players.set(stream.streamId, player);
  resetPlayer(player, stream.mimeType);
  updateEmptyState();
  return player;
}

function mutedIcon() {
  return '<path d="M11 5 6 9H3v6h3l5 4V5z"></path><path d="m22 9-6 6"></path><path d="m16 9 6 6"></path>';
}

function unmutedIcon() {
  return '<path d="M11 5 6 9H3v6h3l5 4V5z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path>';
}

function updateMuteButton(player) {
  const muted = player.video.muted;
  player.muteButton.title = muted ? "Unmute" : "Mute";
  player.muteButton.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  player.muteButton.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${muted ? mutedIcon() : unmutedIcon()}</svg>`;
  player.tile.classList.toggle("audio-on", !muted);
}

function mutePlayer(player) {
  player.video.muted = true;
  updateMuteButton(player);
}

function unmutePlayer(player) {
  for (const other of players.values()) {
    if (other !== player) {
      mutePlayer(other);
    }
  }
  player.video.muted = false;
  updateMuteButton(player);
  player.video.play().catch(() => {});
}

function toggleMute(streamId) {
  const player = players.get(streamId);
  if (!player) {
    return;
  }
  if (player.video.muted) {
    unmutePlayer(player);
  } else {
    mutePlayer(player);
  }
}

function removePlayer(streamId) {
  const player = players.get(streamId);
  if (!player) {
    return;
  }
  if (player.objectUrl) {
    URL.revokeObjectURL(player.objectUrl);
  }
  player.tile.remove();
  players.delete(streamId);
  updateEmptyState();
}

function resetPlayer(player, mimeType) {
  if (player.objectUrl) {
    URL.revokeObjectURL(player.objectUrl);
  }

  player.mediaSource = new MediaSource();
  player.sourceBuffer = null;
  player.queue = [];
  player.pendingCleanup = false;
  player.opened = false;
  player.stream.mimeType = mimeType || player.stream.mimeType || "video/webm";
  player.objectUrl = URL.createObjectURL(player.mediaSource);
  player.video.src = player.objectUrl;
  updateMuteButton(player);

  player.mediaSource.addEventListener("sourceopen", () => {
    if (player.opened) {
      return;
    }
    player.opened = true;
    const mime = MediaSource.isTypeSupported(player.stream.mimeType) ? player.stream.mimeType : "video/webm;codecs=vp8,opus";
    player.sourceBuffer = player.mediaSource.addSourceBuffer(mime);
    player.sourceBuffer.mode = "sequence";
    player.sourceBuffer.addEventListener("updateend", () => {
      maintainLiveEdge(player);
      trimOldBuffer(player);
      flushQueue(player);
    });
    flushQueue(player);
  });
}

function appendChunk(streamId, chunk) {
  const player = players.get(streamId);
  if (!player) {
    return;
  }
  player.queue.push(chunk);
  flushQueue(player);
}

function flushQueue(player) {
  if (!player.sourceBuffer || player.sourceBuffer.updating || player.pendingCleanup || player.queue.length === 0) {
    return;
  }
  const chunk = player.queue.shift();
  try {
    player.sourceBuffer.appendBuffer(chunk);
  } catch {
    player.queue.unshift(chunk);
    resetPlayer(player, player.stream.mimeType);
  }
}

function bufferedEnd(video) {
  if (video.buffered.length === 0) {
    return null;
  }
  return video.buffered.end(video.buffered.length - 1);
}

function maintainLiveEdge(player) {
  const liveEnd = bufferedEnd(player.video);
  if (liveEnd === null) {
    return;
  }

  const delay = liveEnd - player.video.currentTime;
  if (delay > MAX_LIVE_DELAY_SECONDS) {
    player.video.currentTime = Math.max(0, liveEnd - LIVE_EDGE_MARGIN_SECONDS);
  }

  if (player.video.paused) {
    player.video.play().catch(() => {});
  }
}

function trimOldBuffer(player) {
  if (!player.sourceBuffer || player.sourceBuffer.updating || player.video.buffered.length === 0) {
    return;
  }

  const liveEnd = bufferedEnd(player.video);
  if (liveEnd === null) {
    return;
  }

  const removeBefore = liveEnd - BUFFER_RETAIN_SECONDS;
  if (removeBefore <= 0) {
    return;
  }

  const bufferStart = player.video.buffered.start(0);
  if (bufferStart >= removeBefore - 0.5) {
    return;
  }

  try {
    player.pendingCleanup = true;
    player.sourceBuffer.remove(bufferStart, removeBefore);
    player.sourceBuffer.addEventListener("updateend", () => {
      player.pendingCleanup = false;
      flushQueue(player);
    }, { once: true });
  } catch {
    player.pendingCleanup = false;
  }
}

function clearPlayers() {
  for (const streamId of Array.from(players.keys())) {
    removePlayer(streamId);
  }
}

function handleTextMessage(data) {
  if (data.type === "snapshot") {
    clearPlayers();
    data.streams.forEach(createPlayer);
  }
  if (data.type === "stream-start") {
    createPlayer(data.stream);
  }
  if (data.type === "stream-reset") {
    const player = createPlayer(data.stream);
    resetPlayer(player, data.stream.mimeType);
  }
  if (data.type === "stream-stop") {
    removePlayer(data.streamId);
  }
}

async function handleBinaryMessage(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const streamIdLength = view.getUint16(0);
  const streamIdBytes = new Uint8Array(arrayBuffer, 2, streamIdLength);
  const streamId = new TextDecoder().decode(streamIdBytes);
  const chunk = arrayBuffer.slice(2 + streamIdLength);
  appendChunk(streamId, chunk);
}

function connect() {
  socket = new WebSocket(websocketUrl("/ws/watch"));
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    reconnectDelay = 500;
    setStatus("Connected.");
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      handleTextMessage(JSON.parse(event.data));
    } else {
      handleBinaryMessage(event.data);
    }
  });

  socket.addEventListener("close", () => {
    setStatus("Disconnected. Reconnecting...");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.8, 5000);
  });

  socket.addEventListener("error", () => {
    setStatus("Connection error.");
  });
}

connect();
updateEmptyState();
