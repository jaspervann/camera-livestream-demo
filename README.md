# Camera Livestream Demo

Camera Livestream Demo is a small FastAPI application for publishing and watching camera livestreams over WebSockets. Browsers can publish either low-latency JPEG video frames or audio-enabled MediaRecorder chunks, while other browsers watch every active stream in real time. The demo supports multiple publishers, late-joining viewers, camera switching, and local-network use with HTTPS/WSS.

The app has two browser pages:

- `/stream`: opens the device camera, enables the microphone when the selected mode supports audio, shows a local preview, lets the user choose a streaming mode, and starts or stops publishing.
- `/watch`: shows all active livestreams in a responsive grid and updates automatically as streams start, reset, switch mode, or stop.

For implementation-specific design decisions and their rationale, see the [Architecture Decision Record](#adr-live-video-streaming-over-a-restricted-network).

## Functionality

- Supports JPEG frame streaming for the lowest-latency video-only path.
- Supports MediaRecorder streaming for audio-enabled, bandwidth-efficient WebM chunks.
- Sends publisher media to the FastAPI server over a WebSocket at `/ws/publish/{stream_id}`.
- Relays media from the server to all connected watchers over `/ws/watch`.
- Uses image-frame updates for JPEG streams and the browser `MediaSource` API for MediaRecorder streams.
- Supports multiple active publishers at the same time.
- Connects new watchers to streams that were already live before the watcher opened `/watch`.
- Sends stream lifecycle messages so watcher tiles appear, reset, and disappear without refreshing the page.
- Keeps mode-appropriate startup state so late-joining watchers can initialize playback for already-active streams.
- Lets watchers mute/unmute streams with audio, expand a stream tile, and close the expanded view.
- Lets streamers swap between front and rear cameras when the browser and device support both.
- Keeps watchers near the live edge by dropping stale JPEG frames or trimming old buffered MediaRecorder data.
- Reconnects the watch page automatically if its WebSocket connection drops.

## Requirements

- Python 3.10 or newer.
- A browser with support for `getUserMedia`, WebSockets, canvas/image rendering, `MediaRecorder`, and `MediaSource`.
- HTTPS for camera access from phones, tablets, or other network devices. Plain HTTP is generally only accepted by browsers on `localhost`.

## Setup

Use a virtual environment for this project. The examples below assume the venv is named `.venv` in the repository root.

Create and activate the virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Then install the Python dependencies:

```bash
.venv/bin/python -m pip install -r requirements.txt
```

## Run

Localhost testing can use plain HTTP:

```bash
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

For phones, tablets, or other intranet clients, browsers require a secure context for camera access. Run Uvicorn with an intranet-trusted certificate:

```bash
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
```

Then open:

- `https://SERVER:8443/stream`
- `https://SERVER:8443/watch`

All media flows client-to-server over WSS and server-to-watchers over WSS. Clients do not need to connect to each other.

## Tests

```bash
.venv/bin/python -m unittest discover -s tests
```

## Todo
Implement the JPEG Streaming mode. Currently only MediaRecorder Streaming is implemented. From the stream page, the user must be able to select the desired mode.

---

# ADR: Live Video Streaming over a Restricted Network

## Context

The application must support live streaming from devices and browsers within a highly restrictive network environment.

Network constraints:

- Devices cannot communicate directly with each other.
- Devices can only communicate with a central server.
- Only WebSocket communication is permitted for streaming traffic.
- Protocols such as RTSP, RTP, raw TCP/UDP, and peer-to-peer communication are not available.
- The solution must operate entirely through a central server.
- Low latency is an important requirement.

Several streaming approaches were evaluated.

### ❌ WebRTC

WebRTC is generally the preferred solution for low-latency audio/video streaming. However, it is not a good fit for the current environment because:

- Direct peer-to-peer communication is not possible.
- The network only permits WebSocket-based communication.
- WebRTC would lose many of its advantages when all traffic must traverse a central server.

### ❌ HLS / LL-HLS

HLS and Low-Latency HLS are firewall-friendly and work well over HTTP-based networks. However, they are optimized for reliable media delivery at scale rather than ultra-low-latency communication.

Even with Low-Latency HLS, the stream is divided into media segments and partial segments that must be encoded, published, transferred, and buffered before playback can begin. This introduces significantly more latency than is acceptable for the primary use case, where the lowest possible end-to-end delay is a key requirement.

### ❌ RTSP / RTP

RTSP and RTP are widely used protocols for real-time video streaming and are commonly supported by cameras, encoders, and media servers.

However, these protocols are not permitted within the target network. The network only allows WebSocket-based communication between devices and the central server, making RTSP and RTP infeasible from a connectivity and deployment perspective. Adopting RTSP/RTP would require additional protocol gateways, proxies, or tunneling mechanisms, increasing architectural complexity while still not aligning with the network constraints.

### ✅ JPEG Frames over WebSocket

Video frames are captured, encoded as JPEG images, and transmitted individually over a WebSocket connection.

Advantages:

- Very low latency.
- Simple implementation.
- Easy browser support.
- Individual frames can be displayed immediately.

Disadvantages:

- High bandwidth usage.
- No audio support.
- No video compression between frames.

### ✅ MediaRecorder Chunks over WebSocket

Media is captured using the MediaRecorder API and transmitted as encoded video chunks over a WebSocket connection.

Advantages:

- Supports both video and audio.
- Significantly lower bandwidth usage than JPEG streaming.
- Leverages browser-provided media encoders.

Disadvantages:

- Higher latency due to encoding and buffering.
- More complex playback pipeline.
- Latency characteristics depend on browser implementation.

## Decision

The streaming platform will support two streaming modes over WebSocket.

The selected streaming mode shall depend on the functional requirements of the use case:

| Requirement | Recommended Mode |
|------------|------------------|
| Lowest possible latency | JPEG over WebSocket |
| Simple video-only streaming | JPEG over WebSocket |
| Audio support | MediaRecorder over WebSocket |
| Limited bandwidth | MediaRecorder over WebSocket |

### Mode 1: JPEG Streaming

Use JPEG frame streaming over WebSocket when:

- Lowest possible latency is required.
- Audio is not required.
- Available bandwidth is sufficient.

Architecture:

```text
Capture Device
      ↓
 JPEG Frames
      ↓
   WebSocket
      ↓
 Central Server
      ↓
   WebSocket
      ↓
 Viewer
```

The server should maintain a latest-frame-only strategy and drop outdated frames when necessary to minimize latency.

### Mode 2: MediaRecorder Streaming

Use MediaRecorder streaming over WebSocket when:

- Audio is required.
- Bandwidth efficiency is important.
- Slightly higher latency is acceptable.

Architecture:

```text
Capture Device
      ↓
 MediaRecorder Chunks
      ↓
     WebSocket
      ↓
  Central Server
      ↓
     WebSocket
      ↓
     Viewer
```

## Consequences

### Positive

- Works within all known network restrictions.
- Uses a single transport mechanism (WebSocket).
- Allows selection of the most appropriate streaming mode per use case.
- Supports both ultra-low-latency video and audio-enabled streaming.
- Keeps architecture simple and consistent.

### Negative

- JPEG streaming can consume substantial bandwidth.
- MediaRecorder streaming introduces additional latency.
- Two streaming implementations must be maintained.
- No adaptive bitrate or congestion control comparable to WebRTC.
