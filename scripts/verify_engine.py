"""Offline full-worker smoke test. Requires FFmpeg with flite, whisper-cli and a verified speech model."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from uuid import uuid4
import wave

import numpy as np

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "engine"))
from runtime import Runtime
from sync import estimate, HZ

SPOKEN_TEXT = """What surprised me in Shenzhen was how quickly an idea became something you could hold in your hand. I met a founder who walked into a workshop with a sketch in the morning. By the time we met for dinner, she had a working prototype in her bag. That changes how you think about decisions. If testing an idea takes months, you spend most of your time defending your predictions. If testing an idea takes a day, you can spend more time asking better questions. The real advantage is the distance between a question and an answer. That is what I brought home from Shenzhen. Every team can apply that lesson. Start with one decision you keep postponing. Ask yourself what small experiment would give you the confidence to make it this week. Write down the answer, then give yourself permission to change your mind when the evidence changes. Innovation gets interesting when you can replace an argument with a test."""


def media(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", *map(str, args)], check=True)


def inspect(file):
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams",
                                               "-show_format", "-of", "json", str(file)]))


def fixture():
    Path("speech.txt").write_text(SPOKEN_TEXT)
    media("-f", "lavfi", "-i", "flite=textfile=speech.txt:voice=slt", "-ac", 1, "narration.wav")
    # Rotated master. Draw the card in source orientation before adding a rotation matrix.
    Path("headline.txt").write_text("THE QUESTION\n& THE ANSWER")
    Path("byline.txt").write_text("SHENZHEN / GOODTAKE SAMPLE")
    style = ("transpose=clock,drawbox=x=18:y=18:w=iw-36:h=ih-36:c=0x91b78c@0.6:t=1,"
             "drawbox=x=37:y=85:w=iw-74:h=3:c=0xa7cb9f@0.55:t=fill,"
             "drawtext=textfile=headline.txt:font='DejaVu Sans':fontcolor=0xdff2ce:fontsize=25:"
             "line_spacing=8:x=(w-tw)/2:y=h*0.34,"
             "drawtext=textfile=byline.txt:font='DejaVu Sans':fontcolor=0xa7cb9f:fontsize=10:"
             "x=(w-tw)/2:y=h*0.25,transpose=cclock,select='not(eq(mod(n,5),0))'")
    media("-f", "lavfi", "-i", "color=c=0x213428:s=640x360:r=30", "-i", "narration.wav",
          "-vf", style, "-fps_mode", "vfr", "-shortest", "-c:v", "libx264", "-threads", 3,
          "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "raw.mp4")
    media("-display_rotation:v:0", -90, "-i", "raw.mp4", "-map", 0, "-c", "copy", "master.mov")
    media("-ss", 4.25, "-i", "master.mov", "-vf", "hue=h=52", "-c:v", "libx264",
          "-threads", 3, "-preset", "ultrafast", "-c:a", "aac", "camera-b.mp4")
    media("-i", "narration.wav", "-af", "adelay=650:all=1,volume=0.68", "mic.wav")
    info = inspect("master.mov")["streams"][0]
    assert abs(info["side_data_list"][0]["rotation"]) == 90
    assert info["avg_frame_rate"] != info["r_frame_rate"]


def drift():
    rng = np.random.default_rng(27)
    count = 210 * HZ
    main = np.convolve(rng.normal(0, 1, count), np.hanning(51) / 25, mode="same").astype(np.float32)
    offset, rate = 0.84, 1.00065
    other = np.interp((np.arange(int(count * rate + 2 * HZ)) - offset * HZ) / rate,
                      np.arange(count), main, left=0, right=0).astype(np.float32)
    measured = estimate(main, other)
    assert measured["mode"] == "auto", measured
    error = max(abs(measured["offset"] - offset + t * (measured["rate"] - rate)) for t in (0, 210))
    assert error < .03, measured
    assert estimate(main, np.zeros_like(main))["mode"] == "weak"
    print(f"210 s synthetic drift: {error * 1000:.1f} ms maximum fitted endpoint error", flush=True)


def invoke(action, payload, cancel=False):
    task = uuid4().hex
    runtime = Runtime(Path.cwd(), task)
    request = runtime.directory / "request.json"
    request.write_text(json.dumps(payload))
    args = [sys.executable, str(REPO / "engine/app.py"), str(Path.cwd()), action, task, str(request)]
    if cancel:
        child = subprocess.Popen(args, stdout=subprocess.PIPE)
        status = runtime.directory / "status.json"
        cutoff = time.monotonic() + 20
        while not status.exists() and child.poll() is None and time.monotonic() < cutoff:
            time.sleep(.025)
        if not status.exists() or child.poll() is not None:
            child.kill()
            child.communicate()
            raise AssertionError("Render exited before cancellation could be tested.")
        (runtime.directory / "cancel").touch()
        output = child.communicate(timeout=10)[0]
    else:
        output = subprocess.check_output(args)
    data = json.loads(output)
    if cancel:
        assert data == {"error": "Canceled."}, data
        return
    if "error" in data:
        raise AssertionError(f"{action}: {data['error']}")
    return data["value"]


def verify(speech, ranking, demo_dir):
    fixture()
    models = Path("models")
    models.mkdir(exist_ok=True)
    runtime = Runtime(Path.cwd(), uuid4().hex)
    for kind, source in (("speech", speech), ("ranking", ranking)):
        if source:
            runtime.model(kind).symlink_to(source)
            runtime.download(kind)
    start = time.monotonic()
    analysis = dict(brief="What surprised me in Shenzhen", duration=45, aspect="vertical",
                    semantic=bool(ranking), captionStyle="emphasis", offsets={})
    project = invoke("create", {"sources": {"a": "master.mov"}})
    result = invoke("analyze", {"id": project["id"], **analysis})
    assert result["preview"] and len(result["candidates"]) >= 1
    assert any(phrase["words"] for phrase in result["phrases"]), "Missing timed words"
    original = invoke("export", {"id": result["id"], "edit": result["edit"], "path": "single.mp4", "burn": True, "srt": True})
    assert Path(original["path"]).stat().st_size > 10000
    assert 30 <= result["plan"]["duration"] <= 60
    print(f"Single-camera analysis and export: {time.monotonic() - start:.1f} s ({result['ranking']})", flush=True)
    if demo_dir:
        demo_dir.mkdir(parents=True, exist_ok=True)
        media("-i", original["path"], "-vf", "scale=360:640", "-c:v", "libx264", "-threads", 3,
              "-crf", 27, "-c:a", "aac", "-b:a", "56k", "-movflags", "+faststart", demo_dir / "sample-reel.mp4")
        media("-ss", 2, "-i", demo_dir / "sample-reel.mp4", "-frames:v", 1, "-update", 1,
              demo_dir / "sample-poster.jpg")

    project = invoke("create", {"sources": {"a": "master.mov", "b": "camera-b.mp4", "mic": "mic.wav"}})
    result = invoke("analyze", {"id": project["id"], **analysis, "semantic": False})
    for role, expected in (("b", -4.25), ("mic", .65)):
        actual = result["sync"][role]
        assert actual["mode"] == "auto", actual
        error = abs(actual["offset"] - expected)
        assert error < .075, actual
        print(f"{role} source offset error: {error * 1000:.1f} ms", flush=True)

    alignment = invoke("alignment", {"id": result["id"], "role": "b", "offset": -4.25, "start": 6, "useSuggested": False})
    assert abs(float(inspect(alignment["path"])["format"]["duration"]) - 8) < .1

    change = result["edit"]
    change["start"] += .22
    change["crop"] = .68
    phrase = next(p for p in result["phrases"] if change["start"] + .1 < p["start"] < change["end"] - 1)
    change["corrections"][phrase["id"]] = "A corrected caption."
    updated = invoke("preview", {"id": result["id"], "edit": change})
    reopened = invoke("open", {"id": result["id"]})
    assert reopened["edit"] == updated["edit"]
    assert any(segment["role"] == "b" for segment in reopened["plan"]["video"])
    assert all(s["start"] >= 0 and s["end"] <= result["sources"]["b"]["duration"] + .002
               for s in reopened["plan"]["video"] if s["role"] == "b")
    assert any(c["text"] == "A corrected caption." for c in reopened["plan"]["captions"])
    corrected = next(c for c in reopened["plan"]["captions"] if c["text"] == "A corrected caption.")
    assert abs(corrected["start"] - (phrase["start"] - change["start"])) < .01

    Path("camera-b.mp4").rename("moved-b.mp4")
    relinked = invoke("relink", {"id": result["id"], "role": "b", "path": "moved-b.mp4"})
    assert relinked["sources"]["b"]["name"] == "moved-b.mp4"
    settings = {"id": result["id"], "edit": change, "path": "canceled.mp4", "burn": True, "srt": True}
    invoke("export", settings, cancel=True)
    assert not Path("canceled.mp4").exists() and not Path("canceled.srt").exists()
    invoke("export", {**settings, "path": "final.mp4"})
    info = inspect("final.mp4")
    video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in info["streams"] if stream["codec_type"] == "audio")
    duration = reopened["plan"]["duration"]
    assert (video["codec_name"], video["width"], video["height"]) == ("h264", 1080, 1920)
    assert audio["codec_name"] == "aac"
    assert abs(float(video["duration"]) - duration) < .12
    assert abs(float(audio["duration"]) - duration) < .12
    assert "A corrected caption." in Path("final.srt").read_text()
    media("-i", "final.mp4", "-vn", "-ac", 1, "-ar", 16000, "final.wav")
    with wave.open("final.wav", "rb") as decoded:
        pcm = np.frombuffer(decoded.readframes(decoded.getnframes()), dtype="<i2").astype(float)
    for segment in reopened["plan"]["video"][1:]:
        midpoint = int(segment["outputStart"] * 16000)
        assert np.sqrt(np.mean(pcm[midpoint - 8000:midpoint + 8000] ** 2)) > 75
    print(f"Multicam export: {duration:.2f} s, 1080×1920 H.264/AAC; corrected SRT, relink and cancel verified", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--speech", type=Path, required=True)
    parser.add_argument("--ranking", type=Path)
    parser.add_argument("--demo-dir", type=Path)
    args = parser.parse_args()
    speech = args.speech.resolve(strict=True)
    ranking = args.ranking.resolve(strict=True) if args.ranking else None
    demo = args.demo_dir.resolve() if args.demo_dir else None
    drift()
    with tempfile.TemporaryDirectory(prefix="goodtake-smoke-") as work:
        os.chdir(work)
        verify(speech, ranking, demo)
