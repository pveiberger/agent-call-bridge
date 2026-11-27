import io
import json
import threading
import unittest
import wave
from http.server import ThreadingHTTPServer
from http.client import HTTPConnection
from unittest.mock import Mock

from server import Handler, MAX_BODY, MODEL, Tokenizer, glossary, needs_review


def recording(rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        wav.writeframes(bytes(1600))
    return buf.getvalue()


def multipart(data):
    return (b'--sample\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\n'
            b'Content-Type: audio/wav\r\n\r\n' + data + b'\r\n--sample--\r\n')


class Tests(unittest.TestCase):
    def test_decoder_uncertainty_ignores_punctuation_and_handles_missing_scores(self):
        self.assertFalse(needs_review(["▁Ja", "."], [-0.02, -2.3]))
        self.assertTrue(needs_review(["▁Zwei", "▁Tage"], [-0.7, -0.6]))
        self.assertTrue(needs_review(["▁Nein"], [-1.2]))
        self.assertTrue(needs_review(["▁Hallo"], []))
        self.assertTrue(needs_review(["▁Hallo"], [float("nan")]))
    def test_names_use_the_original_model_tokenizer(self):
        tokens = {line.rsplit(" ", 1)[0] for line in (MODEL / "tokens.txt").read_text("utf-8").splitlines()}
        tokenizer = Tokenizer.from_file(str(MODEL / "tokenizer.json"))
        words = glossary("Berlin Mitte|Berlin Mitte|Guten Tag", tokenizer, tokens)
        self.assertEqual(len(words.split("/")), 2)
        self.assertEqual(tokenizer.decode([tokenizer.token_to_id(piece) for piece in words.split("/")[0].split()]),
                         "Berlin Mitte")
        for invalid in ["A:B", "a" * 81, "Name/Name"]:
            with self.assertRaises(ValueError):
                glossary(invalid, tokenizer, tokens)

    def test_upload_validation_and_busy_worker(self):
        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as http:
            http.asr = Mock()
            http.asr.transcribe.return_value = {"text": "Hallo.", "needs_review": False}
            http.worker = threading.Lock()
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                def send(data, headers=None):
                    conn = HTTPConnection("127.0.0.1", http.server_port, timeout=2)
                    try:
                        conn.request("POST", "/v1/audio/transcriptions", data, headers or
                                     {"Content-Type": "multipart/form-data; boundary=sample"})
                        res = conn.getresponse()
                        return res.status, json.loads(res.read())
                    finally:
                        conn.close()
                self.assertEqual(send(multipart(recording())), (200, {"text": "Hallo.", "needs_review": False}))
                self.assertEqual(send(multipart(recording(8000)))[0], 400)
                self.assertEqual(send(multipart(b"not a WAV"))[0], 400)
                self.assertEqual(send(b"", {"Content-Type": "text/plain"})[0], 415)
                self.assertEqual(send(b"x", {"Content-Length": str(MAX_BODY+1),
                                 "Content-Type": "multipart/form-data; boundary=sample"})[0], 413)
                with http.worker:
                    self.assertEqual(send(multipart(recording()))[0], 503)
                self.assertEqual(http.asr.transcribe.call_count, 1)
            finally:
                http.shutdown()
                thread.join()
