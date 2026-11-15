#!/usr/bin/env python3
"""Волна — audio helper.

Reads what is currently playing on the default output device (PipeWire/PulseAudio monitor),
computes a 64-band log spectrum + a bass level and streams them to the Волна Spicetify
extension as Server-Sent Events on http://127.0.0.1:47823/stream.

Only spectrum numbers leave this process (never audio), it listens on localhost only,
answers CORS only for the Spotify client, and captures audio only while a client is connected.
"""
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

HOST, PORT = "127.0.0.1", 47823
ALLOWED_ORIGIN = "https://xpui.app.spotify.com"
RATE = 48000
N = 4096          # FFT window (~85 ms) -> ~12 Hz resolution, enough to separate kick/bass
HOP = 800         # ~60 frames per second
BANDS = 64
FMIN, FMAX = 35.0, 16000.0
BASS = (35.0, 140.0)

freqs = np.fft.rfftfreq(N, 1.0 / RATE)
edges = np.geomspace(FMIN, FMAX, BANDS + 1)
band_bins = []
for lo, hi in zip(edges[:-1], edges[1:]):
    idx = np.where((freqs >= lo) & (freqs < hi))[0]
    if idx.size == 0:
        idx = np.array([int(np.argmin(np.abs(freqs - (lo + hi) / 2)))])
    band_bins.append(idx)
bass_bins = np.where((freqs >= BASS[0]) & (freqs < BASS[1]))[0]
window = np.hanning(N).astype(np.float32)
norm = window.sum() / 2.0


def to_byte(mag):
    db = 20.0 * np.log10(np.maximum(mag, 1e-9))
    return np.clip((db + 75.0) / 65.0, 0.0, 1.0)


class Capture:
    """Runs parec on the default sink monitor while at least one client is connected."""

    def __init__(self):
        self.cond = threading.Condition()
        self.frame = None
        self.seq = 0
        self.clients = 0
        self.thread = None
        self.stop_at = 0.0

    def acquire(self):
        with self.cond:
            self.clients += 1
            if not self.thread or not self.thread.is_alive():
                self.thread = threading.Thread(target=self.run, daemon=True)
                self.thread.start()

    def release(self):
        with self.cond:
            self.clients -= 1
            if self.clients <= 0:
                self.stop_at = time.time() + 3.0

    def default_sink(self):
        try:
            return subprocess.run(["pactl", "get-default-sink"], capture_output=True, text=True, timeout=2).stdout.strip()
        except Exception:
            return ""

    def run(self):
        while True:
            with self.cond:
                if self.clients <= 0 and time.time() >= self.stop_at:
                    self.thread = None
                    return
            sink = self.default_sink()
            proc = subprocess.Popen(
                ["parec", "--device=@DEFAULT_MONITOR@", "--format=float32le", f"--rate={RATE}",
                 "--channels=1", "--latency-msec=15", "--raw", "--client-name=Volna visualizer"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            )
            buf = np.zeros(N, dtype=np.float32)
            last_check = time.time()
            try:
                while True:
                    raw = proc.stdout.read(HOP * 4)
                    if not raw or len(raw) < HOP * 4:
                        break
                    chunk = np.frombuffer(raw, dtype=np.float32)
                    buf = np.concatenate((buf[HOP:], chunk))
                    mag = np.abs(np.fft.rfft(buf * window)) / norm
                    bands = np.array([mag[b].max() for b in band_bins])
                    bass = mag[bass_bins].max() if bass_bins.size else 0.0
                    out = bytes((to_byte(np.append(bands, bass)) * 255).astype(np.uint8))
                    with self.cond:
                        self.frame = out.hex()
                        self.seq += 1
                        self.cond.notify_all()
                        idle = self.clients <= 0 and time.time() >= self.stop_at
                    if idle:
                        return
                    if time.time() - last_check > 3:  # follow output device switches
                        last_check = time.time()
                        if self.default_sink() != sink:
                            break
            finally:
                proc.kill()
                proc.wait()
            time.sleep(0.2)


cap = Capture()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def cors(self):
        if self.headers.get("Origin") == ALLOWED_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)

    def do_GET(self):
        if self.path == "/ping":
            body = b"volna-audio 1"
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path != "/stream":
            self.send_error(404)
            return
        if self.headers.get("Origin") not in (ALLOWED_ORIGIN, None):
            self.send_error(403)
            return
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        cap.acquire()
        seen = -1
        try:
            while True:
                with cap.cond:
                    cap.cond.wait_for(lambda: cap.seq != seen, timeout=1.0)
                    frame, seen = cap.frame, cap.seq
                msg = f"data: {frame}\n\n" if frame else ": idle\n\n"
                self.wfile.write(msg.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            cap.release()


if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"volna-audio on http://{HOST}:{PORT} (pid {os.getpid()})", flush=True)
    srv.serve_forever()
