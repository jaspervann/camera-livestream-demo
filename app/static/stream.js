const preview = document.querySelector("#preview");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const swapButton = document.querySelector("#swapButton");
const statusEl = document.querySelector("#status");

let stream = null;
let currentFacingMode = "user";
let hasUserCamera = false;
let hasEnvironmentCamera = false;
let socket = null;
let recorder = null;
let recorderGeneration = 0;
let streamId = createStreamId();
let isStreaming = false;

const preferredTypes = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8",
  "video/webm"
];

function setStatus(message) {
  statusEl.textContent = message;
}

function websocketUrl(path) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

function createStreamId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  return `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function supportedMimeType() {
  return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function canOpenFacingMode(facingMode) {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: facingMode } },
      audio: false
    });
    probe.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

async function detectCameraSwapSupport() {
  hasUserCamera = currentFacingMode === "user";
  hasEnvironmentCamera = currentFacingMode === "environment";
  swapButton.classList.add("hidden");

  const canUseUserCamera = await canOpenFacingMode("user");
  const canUseEnvironmentCamera = await canOpenFacingMode("environment");

  hasUserCamera = canUseUserCamera;
  hasEnvironmentCamera = canUseEnvironmentCamera;
  swapButton.classList.toggle("hidden", !(hasUserCamera && hasEnvironmentCamera));
}

function videoConstraints(facingMode, exact = false) {
  return {
    facingMode: exact ? { exact: facingMode } : facingMode
  };
}

async function openMedia(facingMode = currentFacingMode, audioTrack = null, exact = false) {
  const cameraStream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints(facingMode, exact),
    audio: audioTrack ? false : { echoCancellation: true, noiseSuppression: true }
  });

  const videoTrack = cameraStream.getVideoTracks()[0];
  const audioTracks = audioTrack ? [audioTrack] : cameraStream.getAudioTracks();
  return new MediaStream([videoTrack, ...audioTracks]);
}

function stopStreamTracks(mediaStream) {
  if (!mediaStream) {
    return;
  }
  mediaStream.getTracks().forEach((track) => track.stop());
}

async function restorePreviewIfNeeded() {
  const videoTrack = stream?.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState === "live") {
    return;
  }

  stopStreamTracks(stream);
  stream = await openMedia(currentFacingMode, null, true);
  preview.srcObject = stream;
}

async function initializeCamera() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus("This browser does not support camera streaming.");
    startButton.disabled = true;
    return;
  }

  try {
    currentFacingMode = "user";
    stream = await openMedia("user");
  } catch {
    currentFacingMode = "environment";
    stream = await openMedia("environment");
  }
  preview.srcObject = stream;
  await detectCameraSwapSupport();
  await restorePreviewIfNeeded();
  setStatus("Camera ready.");
}

function createRecorder(controlType) {
  const mimeType = supportedMimeType();
  const generation = ++recorderGeneration;
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: controlType,
      mimeType: recorder.mimeType || "video/webm"
    }));
  }

  recorder.addEventListener("dataavailable", async (event) => {
    if (generation === recorderGeneration && event.data.size > 0 && socket?.readyState === WebSocket.OPEN) {
      socket.send(await event.data.arrayBuffer());
    }
  });

  recorder.start(250);
}

async function startStreaming() {
  if (!stream) {
    await initializeCamera();
  }
  socket = new WebSocket(websocketUrl(`/ws/publish/${encodeURIComponent(streamId)}`));
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    isStreaming = true;
    createRecorder("start");
    startButton.disabled = true;
    stopButton.disabled = false;
    setStatus("Streaming live.");
  });

  socket.addEventListener("close", () => {
    if (isStreaming) {
      stopStreaming(false);
      setStatus("Streaming connection closed.");
    }
  });

  socket.addEventListener("error", () => {
    setStatus("Streaming connection failed.");
  });
}

function stopRecorder() {
  recorderGeneration += 1;
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
  recorder = null;
}

function stopStreaming(sendStop = true) {
  isStreaming = false;
  stopRecorder();
  if (sendStop && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "stop" }));
  }
  socket?.close();
  socket = null;
  stopStreamTracks(stream);
  stream = null;
  streamId = createStreamId();
  startButton.disabled = false;
  stopButton.disabled = true;
  setStatus("Stream stopped.");
}

async function swapCamera() {
  if (!(hasUserCamera && hasEnvironmentCamera)) {
    return;
  }

  const nextFacingMode = currentFacingMode === "user" ? "environment" : "user";
  const oldStream = stream;
  const existingAudioTrack = oldStream?.getAudioTracks()[0] || null;
  const nextStream = await openMedia(nextFacingMode, existingAudioTrack, true);
  oldStream?.getVideoTracks().forEach((track) => track.stop());
  stream = nextStream;
  currentFacingMode = nextFacingMode;
  preview.srcObject = stream;

  if (isStreaming && socket?.readyState === WebSocket.OPEN) {
    stopRecorder();
    createRecorder("reset");
    setStatus("Camera swapped. Streaming live.");
  }
}

startButton.addEventListener("click", () => {
  startStreaming().catch((error) => setStatus(error.message));
});

stopButton.addEventListener("click", () => stopStreaming(true));

swapButton.addEventListener("click", () => {
  swapCamera().catch((error) => setStatus(error.message));
});

initializeCamera().catch((error) => {
  startButton.disabled = true;
  setStatus(`Camera unavailable: ${error.message}`);
});
