import asyncio
import unittest

from app.state import StreamRegistry, frame_media_chunk


class FakeWatcher:
    def __init__(self) -> None:
        self.json_messages = []
        self.binary_messages = []

    async def send_json(self, data):
        self.json_messages.append(data)

    async def send_bytes(self, data):
        self.binary_messages.append(data)


class SlowWatcher(FakeWatcher):
    def __init__(self) -> None:
        super().__init__()
        self.release = asyncio.Event()

    async def send_bytes(self, data):
        await self.release.wait()
        await super().send_bytes(data)


class StreamRegistryTests(unittest.TestCase):
    def test_start_and_stop_broadcasts_lifecycle(self):
        async def run():
            registry = StreamRegistry()
            watcher = FakeWatcher()
            await registry.add_watcher(watcher)

            await registry.start_stream("s1", "video/webm;codecs=vp8,opus")
            await asyncio.sleep(0)
            await registry.stop_stream("s1")
            await asyncio.sleep(0)

            self.assertEqual(watcher.json_messages[0]["type"], "stream-start")
            self.assertEqual(watcher.json_messages[0]["stream"]["streamId"], "s1")
            self.assertEqual(watcher.json_messages[1], {"type": "stream-stop", "streamId": "s1"})

        asyncio.run(run())

    def test_snapshot_includes_existing_streams_and_startup_chunks(self):
        async def run():
            registry = StreamRegistry()
            await registry.start_stream("s1", "video/webm")
            await registry.relay_chunk("s1", b"first")
            await registry.relay_chunk("s1", b"second")
            await registry.relay_chunk("s1", b"third")
            await registry.relay_chunk("s1", b"fourth")

            watcher = FakeWatcher()
            await registry.send_snapshot(watcher)

            self.assertEqual(watcher.json_messages[0]["type"], "snapshot")
            self.assertEqual(len(watcher.json_messages[0]["streams"]), 1)
            self.assertEqual(watcher.binary_messages, [
                frame_media_chunk("s1", b"first"),
                frame_media_chunk("s1", b"second"),
                frame_media_chunk("s1", b"third"),
            ])

        asyncio.run(run())

    def test_relay_routes_chunks_to_watchers(self):
        async def run():
            registry = StreamRegistry()
            watcher = FakeWatcher()
            await registry.add_watcher(watcher)
            await registry.start_stream("s1", "video/webm")
            await asyncio.sleep(0)

            await registry.relay_chunk("s1", b"payload")
            await asyncio.sleep(0)

            self.assertEqual(watcher.binary_messages, [frame_media_chunk("s1", b"payload")])

        asyncio.run(run())

    def test_slow_watcher_does_not_block_relay_to_other_watchers(self):
        async def run():
            registry = StreamRegistry()
            slow = SlowWatcher()
            fast = FakeWatcher()
            await registry.add_watcher(slow)
            await registry.add_watcher(fast)
            await registry.start_stream("s1", "video/webm")
            await asyncio.sleep(0)

            await registry.relay_chunk("s1", b"payload")
            await asyncio.sleep(0)

            self.assertEqual(fast.binary_messages, [frame_media_chunk("s1", b"payload")])
            self.assertEqual(slow.binary_messages, [])
            slow.release.set()
            await asyncio.sleep(0)

        asyncio.run(run())

    def test_slow_watcher_drops_new_chunks_instead_of_queueing(self):
        async def run():
            registry = StreamRegistry()
            slow = SlowWatcher()
            await registry.add_watcher(slow)
            await registry.start_stream("s1", "video/webm")
            await asyncio.sleep(0)

            await registry.relay_chunk("s1", b"first")
            await asyncio.sleep(0)
            await registry.relay_chunk("s1", b"second")
            await asyncio.sleep(0)

            slow.release.set()
            await asyncio.sleep(0)

            self.assertEqual(slow.binary_messages, [frame_media_chunk("s1", b"first")])

        asyncio.run(run())

    def test_reset_keeps_stream_and_clears_startup_buffer(self):
        async def run():
            registry = StreamRegistry()
            watcher = FakeWatcher()
            await registry.add_watcher(watcher)
            await registry.start_stream("s1", "video/webm")
            await asyncio.sleep(0)
            await registry.relay_chunk("s1", b"before")
            await asyncio.sleep(0)

            await registry.reset_stream("s1", "video/webm;codecs=vp8,opus")
            await asyncio.sleep(0)

            late_watcher = FakeWatcher()
            await registry.send_snapshot(late_watcher)

            self.assertEqual(watcher.json_messages[-1]["type"], "stream-reset")
            self.assertEqual(late_watcher.binary_messages, [])

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
