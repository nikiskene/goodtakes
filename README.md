# GoodTake

GoodTake finds short, standalone excerpts in talks and interviews. Review up to three takes, adjust their framing and captions, and export a local MP4. The browser editor and Mac app both process recordings on the device. Netlify serves the web editor, the product demo and the Mac build link.

## Edit on iPhone or iPad

1. Open [GoodTake’s web editor](https://goodtakes.netlify.app/editor) in Safari. Add MOV or MP4 clips from Photos or Files. Put them in order and optionally add an audio file such as an exported M4A Voice Memo.
2. Tap **Find takes**. The video engine and multilingual speech model download on first use. An internet connection is needed for setup. The browser may reuse cached model files later. Keep the tab open during processing.
3. Choose a take, adjust the trim and correct captions. Tap **Export MP4**, then share the result or download it to Files. You can also download the SRT.

The web editor processes up to three minutes of video and 220 MiB of files combined. A separate voice recording starts at the beginning, replaces the clips’ audio, and supplies the captions. It exports 720×1280 vertical or 1280×720 landscape H.264/AAC. No account is needed. The page keeps the working edit in the current tab. For a longer source, trim a copy in Photos before importing it. Synchronized camera angles and saved projects are available in the Mac app.

## Run on Apple Silicon

Install Xcode Command Line Tools, Node 22+, Rust, Python 3.12, and Homebrew `ffmpeg` and `cmake`. Then run:

```sh
npm ci
bash scripts/setup-runtime.sh
npm run desktop -- dev
```

The first setup builds pinned whisper.cpp and llama.cpp command-line runtimes. If FFmpeg is installed outside your PATH, start the app with `GOODTAKE_FFMPEG` and `GOODTAKE_FFPROBE` set to their absolute executable paths. The setup scripts target macOS/arm64. The worker also runs on Linux for testing.

1. Install the 78 MB multilingual Whisper model from the import screen. Install the optional 398 MB ranking model if you want semantic ranking. The app checks each download against a SHA-256 hash. Once the models are installed, local editing and export work offline.
2. AirDrop the original from your iPhone or choose **File → Export → Export Unmodified Original** from Photos on your Mac. Drop the MOV or MP4 into GoodTake, optionally with a second camera and a WAV, M4A, or MP3 microphone track. Select vertical 9:16 for a phone reel.
3. Enter an optional brief and use **Find takes**. The app opens on the top suggestion. Change the trim, framing, captions or angle and apply **Update preview and save edits**. Changes are stored in the app’s local project library.
4. Use **Export MP4** to save a 1080×1920 or 1920×1080 video with H.264/AAC. Optionally burn in the captions and save a separate SRT. AirDrop the resulting MP4 back to your phone when you’re ready to post.

Camera A defines the project clock. When automatic sync is uncertain, the source stays out of the edit until you apply a manual offset. A positive offset means that source started before Camera A, so the source timestamp matching the start of Camera A is positive. Rendered previews show the selected angle and use the same time ranges and caption layout as exports. If the mic covers the cut, it can supply the continuous audio track. Camera A remains available for cuts that the mic only overlaps in part.

The first release handles one contiguous excerpt per reel, with optional tightening of long pauses. The caption preset uses word emphasis where the transcript has usable word timing and uses phrase timing after manual wording changes. The app recognizes iPhone rotation metadata and variable frame rates, and converts tagged HLG/PQ footage to SDR through FFmpeg. A full iPhone capture/edit/upload experience requires a separate iOS release.

## Package a Mac build

Install Homebrew `cmake`, `pkgconf`, `libass` and `zimg`. Run `npm ci` and `bash scripts/package-macos.sh` on Apple Silicon with Python 3.12 and Rust installed. The bundle includes the local worker and media/ranking runtimes. Find the unsigned app and DMG under `src-tauri/target/aarch64-apple-darwin/release/bundle/`. The **Apple Silicon desktop package** GitHub Actions workflow also builds an unsigned internal test DMG. A public release requires signing, notarization and review of the bundled dependencies in [LICENSES.md](LICENSES.md).

## Netlify

Connect the repo and use `main` as the production branch. Netlify reads `netlify.toml`, builds with Node 22 and publishes `dist`. The build fetches the pinned browser speech model, checks each file’s SHA-256 and serves the weights from the same site. The model files stay out of git. Use `npm run build:web` to build the complete site locally. The sample reel on the page uses an original script, a generated title card and synthesized narration. Netlify serves the demo and editor. The browser downloads the speech model and processes the recording locally. Recordings and exports stay on the device.

The default Mac build link shows the GitHub Actions packaging workflow. Set `VITE_DESKTOP_DOWNLOAD_URL` to a published download if you want to link to it directly.

## Supabase profiles

Run the [profiles and preferences migration](supabase/migrations/20261120000000_profiles_and_preferences.sql) in Supabase SQL Editor. Enable the Email provider and new user signups in Supabase Auth. Set the Auth Site URL to `https://goodtakes.netlify.app/editor` and add that address to Redirect URLs for signup confirmation and password reset. When testing locally, also allow the local editor URL. The confirmation and recovery templates should retain their `{{ .ConfirmationURL }}` link. Existing accounts created with an email code can use **Forgot password?** to set a password on the same account.

The web editor requires an email and password account before importing media or creating a reel. Sign in and open **Profile** to set a display name. Set the project URL and publishable key in an ignored `.env.local` based on `.env.example` for local development. The packaging workflow uses this project’s publishable key by default and accepts the `VITE_SUPABASE_PUBLISHABLE_KEY` GitHub Actions repository variable to override it. The Netlify editor uses the same project and publishable key. The desktop editor can edit local files while signed out.

A profile can store a display name and an explicitly selected default format and caption style. Each profile and preference row is keyed to the signed-in user’s Supabase Auth ID, with owner-only row-level security. The app can read a signed-in user’s assigned role. Role changes require an administrator or server-side operation. Apply the [export entitlements migration](supabase/migrations/20261120000100_export_entitlements.sql) after the profile migration. Each signed-in user can check their own export entitlement against database time. Only trusted server credentials can grant or revoke access. Media and editing data stay on the device. When billing is introduced, verify payment webhooks on the server and enforce export authorization at a server-controlled boundary. Web export is currently available to signed-in users.

## Verify

```sh
npm ci
npm run build
```

The engine smoke test builds its own synthetic material and needs FFmpeg with Flite and rotation support, NumPy, `whisper-cli`, and the pinned Whisper weights. The optional `--ranking` argument accepts the pinned Qwen GGUF and requires `llama-cli` on PATH or configured through `GOODTAKE_LLAMA_CLI`.

```sh
export GOODTAKE_WHISPER_CLI="$PWD/.tooling/bin/whisper-cli"
.tooling/venv/bin/python scripts/verify_engine.py --speech /path/to/ggml-tiny.bin
```

On Linux with user namespaces enabled, prefix the test command with `unshare -Urn` to run with networking disabled. It verifies rotation and VFR metadata, real Whisper transcription using synthesized speech, sync with controlled offsets and drift, a camera switch, subtitle timing and correction, reopening, relinking, canceling and probing the exported MP4. Apple Silicon performance and real iPhone capture quality should be assessed with original footage during the first desktop audition.
