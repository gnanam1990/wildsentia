"""Local SDK/reader checks. All provider and HTTP calls are mocked; no cloud credentials needed."""
import asyncio
import io
import json
import os
from pathlib import Path
import runpy
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

with patch.dict(os.environ, {}, clear=True):
    worker = runpy.run_path(str(Path(__file__).with_name("safari.py")), run_name="safari_tests")


class SafariTests(unittest.TestCase):
    def test_bounded_saved_facts(self):
        fixture = {"source": "checkpoint", "answer": "Saved tiger facts.", "worldTime": 3600}
        with patch("urllib.request.urlopen", return_value=io.BytesIO(json.dumps(fixture).encode())) as request:
            self.assertEqual(worker["read_forest"]("q" * 400), fixture)
            self.assertEqual(len(request.call_args[0][0].full_url.split("q=")[1]), 280)

    def test_oversized_response(self):
        with patch("urllib.request.urlopen", return_value=io.BytesIO(b"x" * 10001)):
            with self.assertRaises(ValueError):
                worker["read_forest"]("question")

    def test_untrusted_source(self):
        with patch("urllib.request.urlopen", return_value=io.BytesIO(b'{"source":"invented","answer":"wrong"}')):
            with self.assertRaises(ValueError):
                worker["read_forest"]("question")

    def check_session(self, provider):
        async def check():
            entry = worker["safari_session"]
            globals_ = entry.__globals__
            callbacks = []
            ctx = SimpleNamespace(room=object(), shutdown=MagicMock(), add_shutdown_callback=callbacks.append)
            session = SimpleNamespace(start=AsyncMock(), generate_reply=AsyncMock(), aclose=AsyncMock())
            env = {} if provider == "cloud" else {"OPENROUTER_API_KEY": "synthetic-key"}
            if provider == "openrouter":
                env["VANA_SAFARI_LLM"] = "vendor/model"
            with (patch.dict(os.environ, env, clear=True),
                  patch.dict(globals_, {"AgentSession": MagicMock(return_value=session), "SafariGuide": MagicMock(return_value=object())}),
                  patch.object(globals_["silero"].VAD, "load", return_value=object()),
                  patch.object(globals_["inference"], "LLM", autospec=True) as cloud,
                  patch.object(globals_["inference"], "STT", autospec=True),
                  patch.object(globals_["inference"], "TTS", autospec=True),
                  patch.object(globals_["openai"], "LLM", autospec=True) as router):
                await entry(ctx)
                if provider == "missing_model":
                    ctx.shutdown.assert_called_once_with(reason="voice_model_not_configured")
                    session.start.assert_not_called()
                else:
                    session.start.assert_awaited_once()
                    session.generate_reply.assert_awaited_once()
                    (cloud if provider == "cloud" else router).assert_called_once()
                    if provider == "cloud":
                        self.assertEqual(cloud.call_args.kwargs["extra_kwargs"]["max_completion_tokens"], 192)
                    else:
                        self.assertEqual(router.call_args.kwargs["max_completion_tokens"], 192)
                    for cleanup in callbacks:
                        await cleanup()
                    session.aclose.assert_awaited_once()
        asyncio.run(check())

    def test_cloud_sdk_and_cleanup(self):
        self.check_session("cloud")

    def test_openrouter_sdk_and_cleanup(self):
        self.check_session("openrouter")

    def test_missing_pinned_voice_model(self):
        self.check_session("missing_model")


if __name__ == "__main__":
    unittest.main()
