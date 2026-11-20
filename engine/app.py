import json
import math
from pathlib import Path
import re
import shutil
import sys
import tempfile
from uuid import uuid4

from editorial import rank, shortlist, transcript
from media import coverage, make_plan, probe, render
from runtime import Cancelled, Runtime, atomic_json
from sync import envelope, estimate

ROLES = ("a", "b", "mic")
WEAK = {"offset": 0, "rate": 1, "mode": "weak", "confidence": 0, "matches": 0}


def checked_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        raise ValueError("Unknown project or job.")
    return value


def load_project(root, project_id):
    directory = root / "projects" / checked_id(project_id)
    project = json.loads((directory / "project.json").read_text())
    if project.get("version") != 1:
        raise ValueError("This project requires a newer version of GoodTake.")
    return directory, project


def check_sources(project):
    for role, source in project["sources"].items():
        try:
            stat = Path(source["path"]).stat()
            if stat.st_size == source["size"] and stat.st_mtime_ns == source["mtime"]:
                continue
        except OSError:
            pass
        raise ValueError(f"Relink {role.upper()} before continuing. {source['name']} moved or changed.")


def save(directory, project):
    atomic_json(directory / "project.json", project)


def create(runtime, payload):
    runtime.stage("Checking your files")
    inputs = payload["sources"]
    sources = {role: probe(runtime, inputs[role], role) for role in ROLES if inputs.get(role)}
    if "a" not in sources:
        raise ValueError("Choose a recording for Camera A.")
    if len({source["path"] for source in sources.values()}) != len(sources):
        raise ValueError("Choose a different file for each source.")
    project_id = uuid4().hex
    directory = runtime.root / "projects" / project_id
    directory.mkdir(parents=True)
    project = {"version": 1, "id": project_id, "name": Path(sources["a"]["name"]).stem,
               "sources": sources, "sync": {}, "phrases": [], "candidates": [], "preview": None,
               "aspect": "vertical", "edit": None}
    save(directory, project)
    return project


def analyze(runtime, directory, project, payload):
    if shutil.disk_usage(directory).free < 256 * 1024**2 + project["sources"]["a"]["duration"] * 32_000:
        raise ValueError("Free space for the local speech analysis cache.")
    check_sources(project)
    runtime.stage("Syncing recordings")
    sources = project["sources"]
    sync_map = project["sync"]
    reference = None
    for role in ("b", "mic"):
        source = sources.get(role)
        if not source:
            continue
        changed = payload.get("offsets", {}).get(role)
        if changed is not None:
            offset = float(changed)
            if not math.isfinite(offset) or abs(offset) >= 8 * 3600:
                raise ValueError("Enter a valid offset in seconds.")
            sync_map[role] = {**WEAK, "mode": "manual", "offset": offset}
        elif role not in sync_map:
            sync_map[role] = WEAK
            if sources["a"]["audioIndex"] is not None and source["audioIndex"] is not None:
                if reference is None:
                    reference = envelope(runtime, sources["a"]["path"])
                sync_map[role] = estimate(reference, envelope(runtime, source["path"]))
    save(directory, project)
    runtime.stage("Transcribing speech on this device")
    speech_role = "a"
    a = sources["a"]
    lo, hi = coverage(sources.get("mic"), sync_map.get("mic"), audio=True)
    if "mic" in sync_map and sync_map["mic"]["mode"] != "weak" and (
        (lo <= a["start"] + 0.15 and hi >= a["duration"] - 0.2) or
        (a["audioIndex"] is None and hi > lo)
    ):
        speech_role = "mic"
    speech = sources[speech_role]
    if speech["audioIndex"] is None:
        raise ValueError("Camera A has no usable audio. Add a microphone track and set its offset.")
    mapping = sync_map[speech_role] if speech_role == "mic" else {"offset": 0, "rate": 1}
    cache_key = [speech["size"], speech["mtime"], mapping["offset"], mapping["rate"], runtime.model("speech").name]
    if project.get("transcriptKey") != cache_key:
        shift = mapping["offset"]
        rate = mapping["rate"]
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            wav = Path(temporary) / "speech.wav"
            runtime.run([runtime.binary("ffmpeg"), "-nostdin", "-v", "error",
                         "-ss", f"{max(0, shift):.6f}", "-i", speech["path"],
                         "-map", f"0:{speech['audioIndex']}", "-vn", "-ac", "1",
                         "-af", f"aresample=16000:first_pts=0,atempo={rate:.8f},adelay={round(max(0, -shift / rate) * 1000)}:all=1",
                         "-ar", "16000", "-t", str(a["duration"]), "-c:a", "pcm_s16le", str(wav)])
            project["phrases"] = transcript(runtime, wav, Path(temporary))
        project["transcriptKey"] = cache_key
        save(directory, project)
    runtime.stage("Finding complete, standalone takes")
    target = int(payload["duration"])
    brief = str(payload["brief"])[:350]
    if target not in (30, 45, 60) or payload["aspect"] not in ("vertical", "landscape"):
        raise ValueError("Choose one of the supported reel formats.")
    cuts, method = rank(runtime, shortlist(project["phrases"], target, brief), target, brief, payload["semantic"])
    for cut in cuts:
        cut["start"] = max(a["start"], cut["start"])
        cut["end"] = min(a["duration"], cut["end"], cut["start"] + 60)
        cut.pop("text", None)
        cut.pop("score", None)
    cuts = [cut for cut in cuts if cut["end"] - cut["start"] >= 29.96]
    project.update(candidates=cuts, ranking=method, brief=brief, target=target, aspect=payload["aspect"])
    if not cuts:
        project.update(edit=None, preview=None, plan=None)
        save(directory, project)
        raise ValueError("There is not enough continuous speech for a 30–60 second take. Try a longer recording or a different target length.")
    top = cuts[0]
    old = project.get("edit") or {}
    style = payload.get("captionStyle") if payload.get("captionStyle") in ("editorial", "emphasis") else "editorial"
    project["edit"] = {"candidate": top["id"], "start": top["start"], "end": top["end"],
                       "angle": old.get("angle", "auto"), "crop": old.get("crop", 0.5),
                       "corrections": old.get("corrections", {}), "captionStyle": style,
                       "tighten": old.get("tighten", False)}
    project.update(preview=None, plan=None)
    save(directory, project)
    return preview(runtime, directory, project)


def edit(project, payload):
    state = project["edit"]
    if not state or payload["candidate"] not in {take["id"] for take in project["candidates"]}:
        raise ValueError("Select an analyzed take.")
    for key in ("start", "end", "crop"):
        state[key] = float(payload[key])
        if not math.isfinite(state[key]):
            raise ValueError("Edit values must be finite numbers.")
    if not 0 <= state["crop"] <= 1 or payload["angle"] not in ("auto", "a", "b"):
        raise ValueError("Choose a valid angle and framing position.")
    if payload["captionStyle"] not in ("editorial", "emphasis"):
        raise ValueError("Choose a valid caption style.")
    corrections = payload.get("corrections", {})
    valid = {phrase["id"] for phrase in project["phrases"]}
    state.update(candidate=payload["candidate"], angle=payload["angle"], captionStyle=payload["captionStyle"],
                 tighten=bool(payload["tighten"]), corrections={
                     key: " ".join(value.split())[:180] for key, value in corrections.items()
                     if key in valid and isinstance(value, str)
                 })
    make_plan(project)


def preview(runtime, directory, project):
    check_sources(project)
    output = directory / f"preview-{runtime.task}.mp4"
    project["plan"] = render(runtime, project, output, preview=True)
    project["preview"] = str(output)
    save(directory, project)
    for old in directory.glob("preview-*.mp4"):
        if old != output:
            old.unlink(missing_ok=True)
    return project


def alignment(runtime, directory, project, payload):
    check_sources(project)
    role = payload["role"]
    if role not in ("b", "mic") or role not in project["sources"]:
        raise ValueError("Choose a second recording to check its alignment.")
    offset = float(payload["offset"])
    start = float(payload["start"])
    if not math.isfinite(offset) or abs(offset) >= 8 * 3600 or not math.isfinite(start):
        raise ValueError("Enter a valid source offset and preview position.")
    mapping = project["sync"].get(role, WEAK)
    if not payload.get("useSuggested") or mapping["mode"] == "weak":
        mapping = {**WEAK, "mode": "manual", "offset": offset}
    project["sync"] = {role: mapping}
    a = project["sources"]["a"]
    lo, hi = coverage(project["sources"][role], mapping, audio=role == "mic")
    start = max(start, a["start"], lo)
    end = min(start + 8, a["duration"], hi)
    if end - start < 1:
        raise ValueError("The recordings do not overlap at that preview position.")
    project["edit"] = {"start": start, "end": end, "angle": "b" if role == "b" else "a",
                       "crop": 0.5, "tighten": False, "corrections": {}, "captionStyle": "editorial"}
    output = directory / f"alignment-{runtime.task}.mp4"
    render(runtime, project, output, preview=True, burn=False)
    for old in directory.glob("alignment-*.mp4"):
        if old != output:
            old.unlink(missing_ok=True)
    return {"path": str(output), "start": start}


def dispatch(runtime, action, payload):
    root = runtime.root
    if action == "models":
        return {kind: runtime.model_ready(kind) for kind in ("speech", "ranking")}
    if action == "download":
        runtime.download(payload["kind"])
        return True
    if action == "list":
        paths = sorted((root / "projects").glob("*/project.json"), key=lambda item: item.stat().st_mtime, reverse=True)
        projects = []
        for path in paths:
            try:
                data = json.loads(path.read_text())
                projects.append({"id": data["id"], "name": data["name"]})
            except (OSError, ValueError, KeyError):
                continue
        return projects
    if action == "create":
        return create(runtime, payload)
    directory, project = load_project(root, payload["id"])
    if action == "open":
        return project
    if action == "relink":
        role = payload["role"]
        if role not in ROLES or role not in project["sources"]:
            raise ValueError("Choose a source belonging to this project.")
        replacement = probe(runtime, payload["path"], role)
        original = project["sources"][role]
        if (replacement["size"] != original["size"] or (original.get("fingerprint") and
                replacement["fingerprint"] != original["fingerprint"]) or replacement["codec"] != original["codec"]
                or abs(replacement["duration"] - original["duration"]) > 0.04):
            raise ValueError("Select the same original recording at its new location.")
        project["sources"][role] = replacement
        save(directory, project)
        return project
    if action == "analyze":
        return analyze(runtime, directory, project, payload)
    if action == "alignment":
        return alignment(runtime, directory, project, payload)
    if action == "preview":
        edit(project, payload["edit"])
        return preview(runtime, directory, project)
    if action == "export":
        check_sources(project)
        edit(project, payload["edit"])
        output = Path(payload["path"]).expanduser().resolve()
        if output.suffix.lower() != ".mp4" or output.exists() or not output.parent.is_dir():
            raise ValueError("Choose a new .mp4 filename in an existing folder.")
        render(runtime, project, output, burn=bool(payload["burn"]), subtitles=bool(payload["srt"]))
        return {"path": str(output)}
    raise ValueError("Unknown GoodTake action.")


def main():
    root, action, task, request_path = sys.argv[1:]
    try:
        runtime = Runtime(Path(root), checked_id(task))
        payload = json.loads(Path(request_path).read_text(encoding="utf-8"))
        result = {"value": dispatch(runtime, action, payload)}
    except (Cancelled, ValueError, OSError, KeyError, TypeError) as exc:
        result = {"error": str(exc)}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
