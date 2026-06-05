from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .state import StreamRegistry


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Camera Livestream Demo")
registry = StreamRegistry()

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> RedirectResponse:
    return RedirectResponse(url="/watch")


@app.get("/stream")
async def stream_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "stream.html")


@app.get("/watch")
async def watch_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "watch.html")


@app.websocket("/ws/publish/{stream_id}")
async def publish_socket(websocket: WebSocket, stream_id: str) -> None:
    await websocket.accept()
    stream_started = False
    try:
        while True:
            try:
                message = await websocket.receive()
            except RuntimeError:
                break
            if text := message.get("text"):
                stream_started = await handle_publish_control(stream_id, text, stream_started)
                continue
            if chunk := message.get("bytes"):
                await registry.relay_chunk(stream_id, chunk)
    except WebSocketDisconnect:
        pass
    finally:
        if stream_started:
            await registry.stop_stream(stream_id)


async def handle_publish_control(stream_id: str, text: str, stream_started: bool) -> bool:
    import json

    data: dict[str, Any] = json.loads(text)
    message_type = data.get("type")
    mime_type = str(data.get("mimeType") or "video/webm")

    if message_type == "start":
        await registry.start_stream(stream_id, mime_type)
        return True
    if message_type == "reset":
        if stream_started:
            await registry.reset_stream(stream_id, mime_type)
        else:
            await registry.start_stream(stream_id, mime_type)
        return True
    if message_type == "stop":
        await registry.stop_stream(stream_id)
        return False
    return stream_started


@app.websocket("/ws/watch")
async def watch_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    await registry.add_watcher(websocket)
    try:
        await registry.send_snapshot(websocket)
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await registry.remove_watcher(websocket)
