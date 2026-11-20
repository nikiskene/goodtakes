import hashlib
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

MODELS = {
    "speech": (
        "ggml-tiny.bin", "ggerganov/whisper.cpp",
        "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21", 78_000_000,
    ),
    "ranking": (
        "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf", "bartowski/Qwen2.5-0.5B-Instruct-GGUF",
        "6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653", 400_000_000,
    ),
}


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


class Cancelled(Exception):
    pass


class Runtime:
    def __init__(self, root, task):
        self.root = root
        self.task = task
        self.directory = root / "jobs" / task
        self.directory.mkdir(parents=True, exist_ok=True)

    def stage(self, message):
        self.check()
        atomic_json(self.directory / "status.json", {"stage": message})

    def check(self):
        if (self.directory / "cancel").exists():
            raise Cancelled("Canceled.")

    def binary(self, name, required=True):
        if getattr(sys, "frozen", False):
            executable = Path(sys.executable).parent.parent / "Resources" / "runtime" / name
            if executable.is_file():
                return str(executable)
        configured = os.environ.get("GOODTAKE_" + name.upper().replace("-", "_"))
        executable = configured or shutil.which(name)
        if executable:
            return executable
        if required:
            raise ValueError(f"{name} is unavailable. Install the GoodTake runtime first.")

    def run(self, args, cwd=None, timeout=None):
        self.check()
        start = time.monotonic()
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            with subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=output, stderr=errors) as child:
                try:
                    while child.poll() is None:
                        self.check()
                        if timeout and time.monotonic() - start > timeout:
                            raise ValueError("The local process exceeded its time limit.")
                        time.sleep(0.1)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                errors.seek(0)
                if child.returncode:
                    raise ValueError(errors.read().decode("utf-8", "replace")[-1600:].strip() or
                                     f"{Path(args[0]).name} failed with code {child.returncode}.")
            output.seek(0)
            return output.read()

    def model(self, kind):
        return self.root / "models" / MODELS[kind][0]

    def model_ready(self, kind):
        path = self.model(kind)
        receipt = path.with_suffix(".verified.json")
        try:
            stat = path.stat()
            return json.loads(receipt.read_text()) == [MODELS[kind][2], stat.st_size, stat.st_mtime_ns]
        except (OSError, ValueError):
            return False

    def download(self, kind):
        name, repo, expected, size = MODELS[kind]
        path = self.model(kind)
        path.parent.mkdir(parents=True, exist_ok=True)
        if self.model_ready(kind):
            return
        digest = hashlib.sha256()
        temporary = path.with_suffix(".partial")
        if shutil.disk_usage(path.parent).free < size + 64 * 1024**2:
            raise ValueError(f"Free at least {(size // 10**6) + 68} MB before downloading this model.")
        try:
            # A locally supplied copy can also be verified and registered without a download.
            if path.exists():
                with path.open("rb") as source:
                    for block in iter(lambda: source.read(1024**2), b""):
                        self.check()
                        digest.update(block)
                if digest.hexdigest() == expected:
                    stat = path.stat()
                    atomic_json(path.with_suffix(".verified.json"), [expected, stat.st_size, stat.st_mtime_ns])
                    return
                digest = hashlib.sha256()
            url = f"https://huggingface.co/{repo}/resolve/main/{name}"
            downloaded = 0
            try:
                import certifi
                context = ssl.create_default_context(cafile=certifi.where())
            except ImportError:
                context = ssl.create_default_context()
            with urlopen(url, timeout=20, context=context) as source, temporary.open("wb") as target:
                while block := source.read(1024**2):
                    self.check()
                    downloaded += len(block)
                    if downloaded > size:
                        raise ValueError("The download exceeded the expected model size.")
                    digest.update(block)
                    target.write(block)
                    self.stage(f"Downloading {kind} model · {downloaded // 10**6} MB")
            if digest.hexdigest() != expected:
                raise ValueError("The model failed its SHA-256 check. Retry setup.")
            temporary.replace(path)
            stat = path.stat()
            atomic_json(path.with_suffix(".verified.json"), [expected, stat.st_size, stat.st_mtime_ns])
        finally:
            temporary.unlink(missing_ok=True)
