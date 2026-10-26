use std::io::Write;
use std::process::{Command, Stdio};

#[tauri::command]
async fn compile_d2(source: String) -> Result<serde_json::Value, String> {
    if source.len() > 8 * 1024 * 1024 {
        return Err("Diagram exceeds the input size limit".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let directory = executable.parent().ok_or("Cannot locate the D2 engine")?;
        let mut command = Command::new(directory.join(if cfg!(windows) {
            "depdoodle-d2.exe"
        } else {
            "depdoodle-d2"
        }));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Unable to start D2: {error}"))?;
        if let Err(error) = child
            .stdin
            .take()
            .ok_or("Cannot write to D2")?
            .write_all(source.as_bytes())
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Unable to send the diagram to D2: {error}"));
        }
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("Invalid D2 response: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![compile_d2])
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
