from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Protocol


class WatchSocket(Protocol):
    async def send_json(self, data: dict[str, Any]) -> None:
        ...

    async def send_bytes(self, data: bytes) -> None:
        ...


@dataclass
class StreamInfo:
    stream_id: str
    mime_type: str
    started_at: float = field(default_factory=time.time)
    startup_chunks: list[bytes] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {
            "streamId": self.stream_id,
            "mimeType": self.mime_type,
            "startedAt": self.started_at,
        }


class StreamRegistry:
    def __init__(self, startup_chunk_limit: int = 3) -> None:
        self._streams: dict[str, StreamInfo] = {}
        self._watchers: set[WatchSocket] = set()
        self._watcher_locks: dict[WatchSocket, asyncio.Lock] = {}
        self._lock = asyncio.Lock()
        self._startup_chunk_limit = startup_chunk_limit

    async def add_watcher(self, watcher: WatchSocket) -> list[StreamInfo]:
        async with self._lock:
            self._watchers.add(watcher)
            self._watcher_locks[watcher] = asyncio.Lock()
            return list(self._streams.values())

    async def remove_watcher(self, watcher: WatchSocket) -> None:
        async with self._lock:
            self._watchers.discard(watcher)
            self._watcher_locks.pop(watcher, None)

    async def start_stream(self, stream_id: str, mime_type: str) -> StreamInfo:
        async with self._lock:
            info = StreamInfo(stream_id=stream_id, mime_type=mime_type)
            self._streams[stream_id] = info
            watchers = list(self._watchers)
        self._broadcast_json({"type": "stream-start", "stream": info.public()}, watchers)
        return info

    async def reset_stream(self, stream_id: str, mime_type: str | None = None) -> StreamInfo | None:
        async with self._lock:
            info = self._streams.get(stream_id)
            if not info:
                return None
            if mime_type:
                info.mime_type = mime_type
            info.startup_chunks.clear()
            watchers = list(self._watchers)
            public = info.public()
        self._broadcast_json({"type": "stream-reset", "stream": public}, watchers)
        return info

    async def stop_stream(self, stream_id: str) -> None:
        async with self._lock:
            existed = self._streams.pop(stream_id, None) is not None
            watchers = list(self._watchers)
        if existed:
            self._broadcast_json({"type": "stream-stop", "streamId": stream_id}, watchers)

    async def get_streams(self) -> list[StreamInfo]:
        async with self._lock:
            return list(self._streams.values())

    async def relay_chunk(self, stream_id: str, chunk: bytes) -> None:
        async with self._lock:
            info = self._streams.get(stream_id)
            if not info:
                return
            if len(info.startup_chunks) < self._startup_chunk_limit:
                info.startup_chunks.append(chunk)
            watchers = list(self._watchers)
        frame = frame_media_chunk(stream_id, chunk)
        self._broadcast_bytes(frame, watchers)

    async def send_snapshot(self, watcher: WatchSocket) -> None:
        async with self._lock:
            streams = list(self._streams.values())
        await watcher.send_json({"type": "snapshot", "streams": [stream.public() for stream in streams]})
        for stream in streams:
            for chunk in stream.startup_chunks:
                await watcher.send_bytes(frame_media_chunk(stream.stream_id, chunk))

    def _broadcast_json(self, data: dict[str, Any], watchers: list[WatchSocket]) -> None:
        for watcher in watchers:
            lock = self._watcher_locks.get(watcher)
            if lock:
                asyncio.create_task(self._send_json(watcher, data, lock))

    def _broadcast_bytes(self, data: bytes, watchers: list[WatchSocket]) -> None:
        for watcher in watchers:
            lock = self._watcher_locks.get(watcher)
            if lock and not lock.locked():
                asyncio.create_task(self._send_bytes(watcher, data, lock))

    async def _send_json(self, watcher: WatchSocket, data: dict[str, Any], lock: asyncio.Lock) -> None:
        try:
            async with lock:
                await watcher.send_json(data)
        except Exception:
            await self._remove_stale([watcher])

    async def _send_bytes(self, watcher: WatchSocket, data: bytes, lock: asyncio.Lock) -> None:
        try:
            async with lock:
                await watcher.send_bytes(data)
        except Exception:
            await self._remove_stale([watcher])

    async def _remove_stale(self, watchers: list[WatchSocket]) -> None:
        if not watchers:
            return
        async with self._lock:
            for watcher in watchers:
                self._watchers.discard(watcher)
                self._watcher_locks.pop(watcher, None)


def frame_media_chunk(stream_id: str, chunk: bytes) -> bytes:
    stream_id_bytes = stream_id.encode("utf-8")
    if len(stream_id_bytes) > 65535:
        raise ValueError("stream_id is too long for websocket media frame")
    return len(stream_id_bytes).to_bytes(2, "big") + stream_id_bytes + chunk
