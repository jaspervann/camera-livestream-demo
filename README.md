# Camera Livestream Demo

Camera Livestream Demo is a small FastAPI application for publishing and watching browser camera livestreams over a local network. It is intended as a simple relay-based demo: publishers send camera and microphone chunks to the server, and watchers receive those chunks from the server. Viewers and publishers do not connect directly to each other.

The app has two browser pages:

- `/stream`: opens the device camera and microphone, shows a local preview, and lets the user start or stop publishing.
- `/watch`: shows all active livestreams in a responsive grid and updates automatically as streams start, reset, or stop.

## Functionality

- Uses the browser `MediaRecorder` API to encode camera and microphone media as WebM chunks.
- Sends publisher media to the FastAPI server over a WebSocket at `/ws/publish/{stream_id}`.
- Relays media from the server to all connected watchers over `/ws/watch`.
- Uses the browser `MediaSource` API on the watch page to append live media chunks into video elements.
- Supports multiple active publishers at the same time.
- Connects new watchers to streams that were already live before the watcher opened `/watch`.
- Sends stream lifecycle messages so watcher tiles appear, reset, and disappear without refreshing the page.
- Keeps a small startup chunk buffer so late-joining watchers can initialize playback for already-active streams.
- Lets watchers mute/unmute streams, expand a stream tile, and close the expanded view.
- Lets streamers swap between front and rear cameras when the browser and device support both.
- Keeps watchers near the live edge and trims old buffered media to avoid unbounded playback delay.
- Reconnects the watch page automatically if its WebSocket connection drops.

## Requirements

- Python 3.10 or newer.
- A browser with support for `getUserMedia`, `MediaRecorder`, WebSockets, and `MediaSource`.
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
