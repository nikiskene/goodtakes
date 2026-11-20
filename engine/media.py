import hashlib
import json
import math
from pathlib import Path
import shutil
import tempfile
import textwrap

VIDEO = {".mp4", ".mov", ".m4v"}
AUDIO = {".wav", ".m4a", ".mp3"}


def probe(runtime, filename, role):
    path = Path(filename).expanduser().resolve(strict=True)
    if not path.is_file() or path.suffix.lower() not in (AUDIO if role == "mic" else VIDEO):
        raise ValueError(f"Choose a {'WAV, M4A or MP3' if role == 'mic' else 'MOV, MP4 or M4V'} file for {role}.")
    raw = runtime.run([runtime.binary("ffprobe"), "-v", "error", "-show_format", "-show_streams",
                       "-of", "json", "-i", str(path)])
    data = json.loads(raw)
    video = next((s for s in data["streams"] if s["codec_type"] == "video"
                  and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    selected = audio if role == "mic" else video
    if not selected or selected["codec_name"] in ("unknown", "none"):
        raise ValueError(f"{path.name} does not contain a supported {role} stream.")
    base = float(data["format"].get("start_time", 0))
    start = max(0., float(selected.get("start_time", base)) - base)
    duration = float(selected.get("duration", data["format"].get("duration", 0)))
    if not math.isfinite(duration) or duration <= 0 or duration > 8 * 3600:
        raise ValueError("Recordings must have a known duration below eight hours.")
    audio_start = max(0., float(audio.get("start_time", base)) - base) if audio else 0.
    audio_end = audio_start + float(audio.get("duration", data["format"].get("duration", 0))) if audio else 0.
    stat = path.stat()
    fingerprint = hashlib.sha256()
    with path.open("rb") as content:
        for position in (0, max(0, stat.st_size // 2 - 32768), max(0, stat.st_size - 65536)):
            content.seek(position)
            fingerprint.update(content.read(65536))
    return {"path": str(path), "name": path.name, "size": stat.st_size, "mtime": stat.st_mtime_ns,
            "start": start, "duration": start + duration, "audioStart": audio_start, "audioEnd": audio_end,
            "fingerprint": fingerprint.hexdigest(), "codec": selected["codec_name"],
            "isHdr": bool(video and video.get("color_transfer") in ("arib-std-b67", "smpte2084")), "videoIndex": video["index"] if video else None,
            "audioIndex": audio["index"] if audio else None}


def coverage(source, sync, audio=False):
    if not source or not sync or sync["mode"] == "weak":
        return (0, 0)
    start = source["audioStart"] if audio else source["start"]
    stop = source["audioEnd"] if audio else source["duration"]
    return (max(0, (start - sync["offset"]) / sync["rate"]),
            max(0, (stop - sync["offset"]) / sync["rate"]))


def make_plan(project):
    edit, sources = project["edit"], project["sources"]
    start, end = edit["start"], edit["end"]
    if start < sources["a"]["start"] or end > sources["a"]["duration"] + 0.001 or not 1 <= end - start <= 60.02:
        raise ValueError("Choose a range of 1–60 seconds inside Camera A’s recording.")
    phrases = project["phrases"]
    keeps = [(start, end)]
    if edit["tighten"]:
        gaps = sorted(((b["start"] - a["end"], a["end"] + 0.45, b["start"] - 0.35)
                       for a, b in zip(phrases, phrases[1:])
                       if a["end"] > start and b["start"] < end and b["start"] - a["end"] >= 1.8), reverse=True)
        cursor = start
        cuts = []
        for _, left, right in gaps[:2]:
            if end - start - sum(b - a for a, b in cuts) - (right - left) >= 30:
                cuts.append((left, right))
        keeps = []
        for left, right in sorted(cuts):
            keeps.append((cursor, left))
            cursor = right
        keeps.append((cursor, end))

    clip_b, clip_mic = sources.get("b"), sources.get("mic")
    map_a = {"offset": 0, "rate": 1, "mode": "auto"}
    map_b, map_mic = project["sync"].get("b"), project["sync"].get("mic")
    lo_b, hi_b = coverage(clip_b, map_b)
    lo_mic, hi_mic = coverage(clip_mic, map_mic, audio=True)
    audio_role = "mic" if lo_mic <= start + 0.002 and hi_mic >= end - 0.002 else "a"
    if sources[audio_role]["audioIndex"] is None:
        # A manually synced, partial mic can still supply the intersection.
        audio_role = "mic" if hi_mic > start and lo_mic < end else None
    audio_map = map_mic if audio_role == "mic" else map_a
    main_b = edit["angle"] == "b"
    switch = None
    if edit["angle"] == "auto" and hi_b - lo_b >= 5:
        midpoint = (start + end) / 2
        beats = [line["start"] for line in phrases if max(start + 4, lo_b) <= line["start"]
                 <= min(end - 4, hi_b - 4) and any(left <= line["start"] < right for left, right in keeps)]
        if beats:
            switch = min(beats, key=lambda beat: abs(beat - midpoint))

    def source_range(role, mapping, left, right, output):
        return {"role": role, "start": mapping["offset"] + left * mapping["rate"],
                "end": mapping["offset"] + right * mapping["rate"], "rate": mapping["rate"],
                "outputStart": output, "outputEnd": output + right - left}

    video, audio, captions = [], [], []
    output = 0.
    for left, right in keeps:
        begin_b = max(left, lo_b, switch if switch is not None else left)
        end_b = min(right, hi_b)
        if (main_b or switch is not None) and end_b - begin_b >= 0.1:
            partitions = [(left, begin_b, "a", map_a), (begin_b, end_b, "b", map_b),
                          (end_b, right, "a", map_a)]
        else:
            partitions = [(left, right, "a", map_a)]
        for a, b, role, mapping in partitions:
            if b - a > 0.0001:
                video.append(source_range(role, mapping, a, b, output + a - left))
        if audio_role:
            audio.append(source_range(audio_role, audio_map, left, right, output))
        for line in phrases:
            a, b = max(left, line["start"]), min(right, line["end"])
            if b - a < 0.12:
                continue
            correction = edit["corrections"].get(line["id"])
            offset = output - left
            words = [{"text": word["text"], "start": max(word["start"], a) + offset,
                      "end": min(word["end"], b) + offset} for word in line["words"]
                     if min(word["end"], b) - max(word["start"], a) > 0.025]
            text = correction if correction is not None else (
                " ".join(word["text"] for word in words) if words and
                (a > line["start"] or b < line["end"]) else line["text"])
            if text.strip():
                captions.extend(wrap_caption(text, a + offset, b + offset, words if correction is None else [],
                                             27 if project["aspect"] == "vertical" else 41))
        output += right - left
    return {"video": video, "audio": audio, "captions": captions, "duration": output}


def wrap_caption(text, start, end, words, width):
    lines = textwrap.wrap(text, width=width)
    groups = [lines[i:i + 2] for i in range(0, len(lines), 2)]
    cues = []
    consumed = 0
    for index, group in enumerate(groups):
        content = "\n".join(group)
        group_words = content.split()
        timing = words[consumed:consumed + len(group_words)]
        consumed += len(group_words)
        if [word["text"] for word in timing] != group_words:
            timing = []
        a = start + (end - start) * index / len(groups)
        b = start + (end - start) * (index + 1) / len(groups)
        if timing and len(groups) == 1:
            a, b = start, end
        beats = []
        for word in timing:
            if a <= word["start"] < b:
                beats.append(word["start"])
        cues.append({"start": a, "end": b, "text": content,
                     "beats": beats if len(beats) == len(group_words) else []})
    return cues


def stamp(seconds, ass=False):
    base = 100 if ass else 1000
    ticks = round(max(0, seconds) * base)
    hour, remaining = divmod(ticks, 3600 * base)
    minute, remaining = divmod(remaining, 60 * base)
    sec, fraction = divmod(remaining, base)
    return f"{hour}:{minute:02}:{sec:02}.{fraction:02}" if ass else f"{hour:02}:{minute:02}:{sec:02},{fraction:03}"


def srt(captions):
    return "\n\n".join(f"{index}\n{stamp(cue['start'])} --> {stamp(cue['end'])}\n{cue['text']}"
                        for index, cue in enumerate(captions, 1)) + ("\n" if captions else "")


def ass_file(captions, width, height, emphasis):
    vertical = height > width
    font = 62 if vertical else 55
    margin = 255 if vertical else 95
    prefix = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: GoodTake,DejaVu Sans,{font},&H00FFFFFF,&H00FFFFFF,&H00131313,&H90000000,-1,0,0,0,100,100,0,0,1,3,2,2,80,80,{margin},1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    rows = []
    for cue in captions:
        text = cue["text"].replace("\\", "＼").replace("{", "｛").replace("}", "｝")
        words = text.split()
        beats = cue["beats"] if emphasis else []
        breaks = len(text.split("\n")[0].split()) if "\n" in text else -1
        if beats and len(beats) == len(words):
            times = [cue["start"]] + beats + [cue["end"]]
            for index, (a, b) in enumerate(zip(times, times[1:]), -1):
                if stamp(a, True) == stamp(b, True):
                    continue
                styled = [r"{\c&H73F8D1&}" + word + r"{\c}" if i == index else word
                          for i, word in enumerate(words)]
                line = " ".join(styled) if breaks < 0 else " ".join(styled[:breaks]) + r"\N" + " ".join(styled[breaks:])
                rows.append(f"Dialogue: 0,{stamp(a, True)},{stamp(b, True)},GoodTake,,0,0,0,,{line}")
        else:
            line = text.replace("\n", r"\N")
            rows.append(f"Dialogue: 0,{stamp(cue['start'], True)},{stamp(cue['end'], True)},GoodTake,,0,0,0,,{line}")
    return prefix + "\n".join(rows) + "\n"


def render(runtime, project, output, preview=False, burn=True, subtitles=False):
    plan = make_plan(project)
    dimensions = (1080, 1920) if project["aspect"] == "vertical" else (1920, 1080)
    width, height = dimensions
    minimum = max(100 * 1024**2, int(plan["duration"] * 2 * 1024**2))
    if shutil.disk_usage(output.parent).free < minimum:
        raise ValueError(f"Free at least {minimum // 1024**2} MB on the destination drive.")
    runtime.stage("Preparing preview" if preview else "Rendering MP4 on this device")
    with tempfile.TemporaryDirectory(prefix=".goodtake-", dir=output.parent) as directory:
        work = Path(directory)
        args = [runtime.binary("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-filter_complex_threads", "2"]
        filters, video_labels, audio_labels = [], [], []
        position = project["edit"]["crop"]
        for index, segment in enumerate(plan["video"]):
            source = project["sources"][segment["role"]]
            args += ["-ss", f"{max(0, segment['start']):.6f}", "-i", source["path"]]
            duration = segment["outputEnd"] - segment["outputStart"]
            label = f"v{index}"
            color = ("zscale=transfer=linear:npl=100,format=gbrpf32le,zscale=primaries=bt709,"
                     "tonemap=mobius:desat=1.5,zscale=transfer=bt709:matrix=bt709:range=limited,"
                     "format=yuv420p," if source.get("isHdr") else "")
            filters.append(f"[{index}:{source['videoIndex']}]setpts=(PTS-STARTPTS)/{segment['rate']:.8f},"
                           f"fps=30,{color}scale={width}:{height}:force_original_aspect_ratio=increase:force_divisible_by=2:out_color_matrix=bt709,"
                           f"crop={width}:{height}:(iw-ow)*{position:.4f}:(ih-oh)*{position:.4f},"
                           f"setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.09,"
                           f"trim=duration={duration:.6f},setpts=PTS-STARTPTS[{label}]")
            video_labels.append(f"[{label}]")
        filters.append("".join(video_labels) + f"concat=n={len(video_labels)}:v=1:a=0[video]")
        for index, segment in enumerate(plan["audio"]):
            source = project["sources"][segment["role"]]
            duration = segment["outputEnd"] - segment["outputStart"]
            delay = max(0., -segment["start"])
            stream_start = max(0., segment["start"], source["audioStart"])
            delay = max(delay, (stream_start - segment["start"]) / segment["rate"])
            if stream_start >= min(segment["end"], source["audioEnd"]):
                filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={duration:.6f}[a{index}]")
            else:
                args += ["-ss", f"{stream_start:.6f}", "-i", source["path"]]
                input_index = len(video_labels) + sum(1 for item in audio_labels if item[1])
                filters.append(f"[{input_index}:{source['audioIndex']}]asetpts=PTS-STARTPTS,"
                               f"atrim=duration={segment['end'] - stream_start:.6f},"
                               f"atempo={segment['rate']:.8f},aformat=sample_rates=48000:channel_layouts=stereo,"
                               f"adelay={round(delay * 1000)}:all=1,apad,atrim=duration={duration:.6f},"
                               f"afade=d=0.035,afade=t=out:st={max(0, duration - 0.035):.6f}:d=0.035[a{index}]")
            audio_labels.append((f"[a{index}]", stream_start < min(segment["end"], source["audioEnd"])))
        if audio_labels:
            filters.append("".join(label for label, _ in audio_labels) +
                           f"concat=n={len(audio_labels)}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[audio]")
        else:
            filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={plan['duration']:.6f}[audio]")
        video = "[video]"
        if burn:
            (work / "captions.ass").write_text(ass_file(plan["captions"], width, height,
                                                       project["edit"]["captionStyle"] == "emphasis"), encoding="utf-8")
            font_dir = Path(runtime.binary("ffmpeg")).parent / "fonts"
            if not font_dir.is_dir():
                font_dir = Path(__file__).resolve().parents[1] / "assets"
            if font_dir.is_dir():
                (work / "fonts").mkdir()
                for font in font_dir.glob("*.ttf"):
                    shutil.copyfile(font, work / "fonts" / font.name)
            fonts = ":fontsdir=fonts" if (work / "fonts").is_dir() else ""
            filters.append(f"[video]ass=captions.ass{fonts}[captioned]")
            video = "[captioned]"
        if preview:
            filters.append(f"{video}scale={width // 2}:{height // 2}[preview]")
            video = "[preview]"
        media = work / "video.mp4"
        encoders = runtime.run([args[0], "-hide_banner", "-encoders"])
        if b"libx264" in encoders:
            encoding = ["-c:v", "libx264", "-threads", "4", "-preset", "ultrafast" if preview else "fast",
                        "-crf", "24" if preview else "18"]
        elif b"h264_videotoolbox" in encoders:
            encoding = ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "3M" if preview else "12M"]
        else:
            raise ValueError("The local FFmpeg build has no supported H.264 encoder.")
        args += ["-filter_complex", ";".join(filters), "-map", video, "-map", "[audio]",
                 "-t", f"{plan['duration']:.6f}", *encoding,
                 "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                 "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(media)]
        runtime.run(args, cwd=work)
        runtime.check()
        sidecar = output.with_suffix(".srt")
        if subtitles:
            (work / "captions.srt").write_text(srt(plan["captions"]), encoding="utf-8")
            if sidecar.exists():
                raise ValueError("An SRT with that name exists. Choose a different export name.")
        if preview:
            media.replace(output)
        else:
            # Hard links publish without replacing another file, on the same destination filesystem.
            published_srt = False
            try:
                if subtitles:
                    sidecar.hardlink_to(work / "captions.srt")
                    published_srt = True
                output.hardlink_to(media)
            except OSError:
                if published_srt:
                    sidecar.unlink()
                raise
    return plan
