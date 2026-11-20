"""Exercise the packaged worker and its bundled binaries on Apple Silicon."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from uuid import uuid4

from verify_engine import REPO, Runtime


def verify(bundle, model, work):
    worker = bundle / "Contents/MacOS/goodtake-worker"
    ffprobe = bundle / "Contents/Resources/runtime/ffprobe"
    runtime = Runtime(work, uuid4().hex)
    runtime.model("speech").parent.mkdir()
    runtime.model("speech").symlink_to(model)
    runtime.download("speech")

    def invoke(action, payload):
        task = uuid4().hex
        with tempfile.NamedTemporaryFile(mode="w", dir=work, suffix=".json") as request:
            json.dump(payload, request)
            request.flush()
            result = subprocess.run([worker, work, action, task, request.name], capture_output=True, text=True, check=True)
        data = json.loads(result.stdout)
        if "error" in data:
            raise RuntimeError(data["error"])
        return data["value"]

    project = invoke("create", {"sources": {"a": str(REPO / "public/sample-reel.mp4")}})
    project = invoke("analyze", {"id": project["id"], "duration": 30, "brief": "",
                                 "aspect": "vertical", "semantic": False, "captionStyle": "editorial", "offsets": {}})
    output = work / "packaged-reel.mp4"
    invoke("export", {"id": project["id"], "edit": project["edit"], "path": str(output), "burn": True, "srt": True})
    inspected = subprocess.check_output([ffprobe, "-v", "error", "-show_streams", "-of", "json", output], text=True)
    streams = json.loads(inspected)["streams"]
    video = next(s for s in streams if s["codec_type"] == "video")
    assert (video["codec_name"], video["width"], video["height"]) == ("h264", 1080, 1920)
    assert any(s["codec_name"] == "aac" for s in streams)
    assert "-->" in output.with_suffix(".srt").read_text()
    print("Packaged Apple Silicon worker produced a 1080×1920 H.264/AAC reel and SRT.")


if __name__ == "__main__":
    bundle, model = map(lambda path: Path(path).resolve(strict=True), sys.argv[1:])
    with tempfile.TemporaryDirectory(prefix="goodtake-packaged-") as directory:
        verify(bundle, model, Path(directory))
