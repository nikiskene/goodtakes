# Third-party components

GoodTake launches FFmpeg, ffprobe, Whisper and llama.cpp as distinct executable processes. Consult each upstream notice before distributing builds.

| Component | Upstream | License and distribution notes |
| --- | --- | --- |
| FFmpeg 7.1.5 | [FFmpeg source](https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz) | The packaging script builds the LGPL variant with Apple VideoToolbox, libass and zimg. It does not enable GPL or nonfree code. If redistributing, include the applicable notices and complete corresponding source for the exact build, including changes and build instructions. Review codec patent obligations for your markets. Local Linux verification used Debian FFmpeg with libx264. |
| libass and dependencies | [libass](https://github.com/libass/libass) | ISC for libass. The release bundles the recursive Homebrew dylib dependencies of libass and zimg. Audit exact versions, copyright notices and requirements of the resulting dependency set before publication. |
| zimg | [zimg](https://github.com/sekrit-twc/zimg) | WTFPL with exceptions for bundled files. Use upstream notices for the exact revision bundled. |
| whisper.cpp and Whisper tiny | [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [OpenAI Whisper](https://github.com/openai/whisper) | MIT. The app downloads multilingual ggml weights separately and verifies SHA-256. |
| llama.cpp and Qwen2.5-0.5B-Instruct | [llama.cpp](https://github.com/ggml-org/llama.cpp), [Qwen model](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) | MIT for llama.cpp and Apache-2.0 for the model. The optional quantized file is downloaded separately and verified. |
| DejaVu Sans | [DejaVu](https://dejavu-fonts.github.io/) | See the preserved copyright and conditions in `assets/DejaVu-LICENSE.txt`. |
| Python runtime and packages | [Python](https://www.python.org/), [NumPy](https://numpy.org/), [PyInstaller](https://pyinstaller.org/), [certifi](https://github.com/certifi/python-certifi) | The PyInstaller sidecar packages Python, NumPy and a CA bundle. Collect their notices for redistribution, including linked NumPy libraries and the PyInstaller bootloader exception. |
| Product demo | GoodTake synthetic fixture | Original scripted text, generated graphics and synthesized voice. The Flite utility generates the sample offline and is never shipped with GoodTake. |

Internal unsigned build artifacts are intended for evaluation. Before publishing a desktop release, complete the binary dependency and notice audit above and arrange Apple Developer ID signing and notarization.

## Browser editor

The browser uses the ffmpeg.wasm single-threaded core 0.12.10 (GPL-2.0-or-later) and its MIT-licensed JavaScript wrapper. See the [browser third-party notices](public/web-third-party.txt) for corresponding source and licensing information. Transformers.js, ONNX Runtime Web, the pinned Whisper tiny ONNX conversion and Noto Sans CJK supply local speech recognition and captions.
