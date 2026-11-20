#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::Manager;

#[derive(Default)]
struct Jobs {
    busy: AtomicBool,
    exported: Mutex<Option<PathBuf>>,
}

struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn job_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.len() != 32
        || !id
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
    {
        return Err("Invalid job ID.".into());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("jobs")
        .join(id))
}

fn worker() -> Result<Command, String> {
    if cfg!(debug_assertions) {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let local = repo.join(".tooling/venv/bin/python");
        let mut command = if local.is_file() {
            Command::new(local)
        } else {
            Command::new("python3")
        };
        command.arg(repo.join("engine/app.py"));
        let bins = repo.join(".tooling/bin");
        for (env, file) in [
            ("GOODTAKE_WHISPER_CLI", "whisper-cli"),
            ("GOODTAKE_LLAMA_CLI", "llama-cli"),
        ] {
            let path = bins.join(file);
            if path.is_file() {
                command.env(env, path);
            }
        }
        return Ok(command);
    }
    let host = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = host.parent().ok_or("Missing app bundle directory.")?;
    Ok(Command::new(parent.join("goodtake-worker")))
}

#[tauri::command]
async fn run_job(
    app: tauri::AppHandle,
    id: String,
    action: String,
    payload: Value,
) -> Result<Value, String> {
    if ![
        "models",
        "download",
        "list",
        "create",
        "open",
        "analyze",
        "preview",
        "alignment",
        "export",
        "relink",
    ]
    .contains(&action.as_str())
    {
        return Err("Unknown GoodTake action.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Jobs>();
        let work = job_dir(&app, &id)?;
        if state.busy.swap(true, Ordering::Acquire) {
            return Err("Wait for the current job to finish.".into());
        }
        let _busy = Busy(&state.busy);
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(work.parent().ok_or("Invalid job directory.")?)
            .map_err(|e| e.to_string())?;
        fs::create_dir(&work).map_err(|e| e.to_string())?;
        let request = work.join("request.json");
        let result = (|| {
            fs::write(&request, payload.to_string()).map_err(|e| e.to_string())?;
            let output = worker()?
                .arg(root)
                .arg(&action)
                .arg(&id)
                .arg(request)
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("Could not launch the local worker. {e}"))?;
            let mut data: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
                let details = String::from_utf8_lossy(&output.stderr);
                format!(
                    "The local worker stopped. {}",
                    details.chars().take(900).collect::<String>()
                )
            })?;
            if let Some(error) = data["error"].as_str() {
                return Err(error.to_owned());
            }
            let value = data["value"].take();
            if action == "export" {
                if let Some(path) = value["path"].as_str() {
                    *state.exported.lock().map_err(|e| e.to_string())? = Some(PathBuf::from(path));
                }
            }
            Ok(value)
        })();
        let _ = fs::remove_dir_all(work);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn job_status(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    let path = job_dir(&app, &id)?.join("status.json");
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn cancel_job(app: tauri::AppHandle, id: String) -> Result<(), String> {
    fs::write(job_dir(&app, &id)?.join("cancel"), []).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_export(state: tauri::State<'_, Jobs>) -> Result<(), String> {
    let exported = state.exported.lock().map_err(|e| e.to_string())?;
    let path = exported.as_ref().ok_or("Export a reel first.")?;
    let mut command = if cfg!(target_os = "macos") {
        let mut open = Command::new("/usr/bin/open");
        open.arg("-R").arg(path);
        open
    } else {
        let mut open = Command::new("xdg-open");
        open.arg(path.parent().ok_or("Missing export folder.")?);
        open
    };
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Jobs::default())
        .invoke_handler(tauri::generate_handler![
            run_job,
            job_status,
            cancel_job,
            reveal_export
        ])
        .run(tauri::generate_context!())
        .expect("could not run GoodTake");
}
