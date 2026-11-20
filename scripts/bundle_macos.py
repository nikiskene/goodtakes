"""Copy and relocate Homebrew libraries used by the independently executable FFmpeg."""
from pathlib import Path
import re
import shutil
import subprocess
import sys


def execute(*command):
    return subprocess.check_output(command, text=True)


def dependencies(binary):
    output = execute("otool", "-L", binary)
    return [match[1] for line in output.splitlines()[1:]
            if (match := re.match(r"\s+(\S+) \(compatibility version", line))]


def resolve(load_path, origin, target, executable_dir):
    binary = origin or target
    directory = binary.parent
    if load_path.startswith("@loader_path/"):
        return directory / load_path.removeprefix("@loader_path/")
    if load_path.startswith("@executable_path/"):
        return executable_dir / load_path.removeprefix("@executable_path/")
    if not load_path.startswith("@rpath/"):
        return Path(load_path)
    relative = load_path.removeprefix("@rpath/")
    search = [directory, Path("/opt/homebrew/lib")]
    commands = execute("otool", "-l", binary)
    for entry in re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset", commands):
        value = entry.replace("@loader_path", str(directory)).replace("@executable_path", str(executable_dir))
        search.insert(0, Path(value))
    return next((folder / relative for folder in search if (folder / relative).is_file()), Path(load_path))


def bundle(runtime):
    pending = [(runtime / name, None) for name in ("ffmpeg", "ffprobe")]
    handled = set()
    known = {}
    while pending:
        target, origin = pending.pop()
        if target in handled:
            continue
        handled.add(target)
        target.chmod(0o755)
        for load_path in dependencies(target):
            if load_path.startswith(("/System/Library/", "/usr/lib/")):
                continue
            if origin and (load_path == str(origin) or Path(load_path).name == origin.name and load_path.startswith("@rpath/")):
                execute("install_name_tool", "-id", f"@loader_path/{target.name}", target)
                continue
            path = resolve(load_path, origin, target, runtime)
            if not path.is_absolute() or not path.is_file():
                raise SystemExit(f"Cannot relocate {load_path} used by {target.name}.")
            resolved = path.resolve()
            name = path.name
            if name in known and known[name] != resolved:
                raise SystemExit(f"Conflicting runtime libraries named {name}.")
            if name not in known:
                known[name] = resolved
                shutil.copyfile(resolved, runtime / name)
                pending.append((runtime / name, path))
            execute("install_name_tool", "-change", load_path, f"@loader_path/{name}", target)
        execute("codesign", "--force", "--sign", "-", target)


if __name__ == "__main__":
    bundle(Path(sys.argv[1]))
