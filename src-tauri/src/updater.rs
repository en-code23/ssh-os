//! Self-updater without extra signing keys: finds the latest GitHub release, downloads the
//! asset for this platform, verifies the SHA-256 digest GitHub publishes for every release
//! asset (refusing to install without one), then installs and relaunches.
//!  - macOS:   SSH-OS-mac-<arch>.zip  -> swap the .app bundle after we exit, reopen it
//!  - Windows: SSH-OS-Setup-x64.exe   -> run the installer silently after we exit, relaunch
use anyhow::{anyhow, bail, Context, Result};
use futures::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const REPO: &str = "en-code23/ssh-os";

#[derive(Default)]
struct Pending {
    url: String,
    sha256: String,
    file: Option<PathBuf>,
}

pub struct Updater {
    app: AppHandle,
    http: reqwest::Client,
    state: Mutex<Value>,
    pending: Mutex<Option<Pending>>,
}

fn current_version(app: &AppHandle) -> String {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("SSHOS_FAKE_VERSION") {
        return v; // lets the self-test exercise a real update
    }
    app.package_info().version.to_string()
}

fn newer(a: &str, b: &str) -> bool {
    let p = |s: &str| s.trim_start_matches('v').split(['.', '-']).map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (p(a), p(b));
    for i in 0..3 {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

fn asset_name() -> Option<String> {
    if cfg!(target_os = "macos") {
        Some(format!("SSH-OS-mac-{}.zip", if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }))
    } else if cfg!(target_os = "windows") {
        Some("SSH-OS-Setup-x64.exe".into())
    } else {
        None
    }
}

impl Updater {
    pub fn new(app: AppHandle, http: reqwest::Client) -> Self {
        let cur = current_version(&app);
        let supported = !cfg!(debug_assertions) || std::env::var("SSHOS_FAKE_VERSION").is_ok();
        let status = if supported && asset_name().is_some() { "idle" } else { "unsupported" };
        Self { app, http, state: Mutex::new(json!({"status": status, "current": cur})), pending: Mutex::new(None) }
    }

    fn set(&self, patch: Value) {
        let v = {
            let mut s = self.state.lock().unwrap();
            for (k, val) in patch.as_object().unwrap() {
                s[k] = val.clone();
            }
            s.clone()
        };
        let _ = self.app.emit("update:state", v);
    }

    pub fn state(&self) -> Value {
        self.state.lock().unwrap().clone()
    }

    fn status(&self) -> String {
        self.state.lock().unwrap()["status"].as_str().unwrap_or("").to_string()
    }

    pub async fn check(&self) -> Result<()> {
        let st = self.status();
        if st == "unsupported" || st == "downloading" || st == "downloaded" {
            return Ok(());
        }
        self.set(json!({"status": "checking", "error": null}));
        match self.check_inner().await {
            Ok(()) => Ok(()),
            Err(e) => {
                self.set(json!({"status": "error", "error": e.to_string()}));
                Ok(())
            }
        }
    }

    async fn check_inner(&self) -> Result<()> {
        let rel: Value = self
            .http
            .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?
            .error_for_status()
            .context("Could not reach GitHub")?
            .json()
            .await?;
        let version = rel["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
        let cur = current_version(&self.app);
        let now = crate::store::now_ms();
        if version.is_empty() || !newer(&version, &cur) {
            *self.pending.lock().unwrap() = None;
            self.set(json!({"status": "not-available", "checkedAt": now}));
            return Ok(());
        }
        let name = asset_name().ok_or_else(|| anyhow!("Updates are not supported on this platform"))?;
        let asset = rel["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"] == name.as_str())).ok_or_else(|| anyhow!("Release {version} has no {name} yet"))?;
        let url = asset["browser_download_url"].as_str().unwrap_or("").to_string();
        if !url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) {
            bail!("Unexpected download location");
        }
        // never install anything we cannot verify
        let digest = asset["digest"].as_str().unwrap_or("");
        let sha256 = digest.strip_prefix("sha256:").filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())).ok_or_else(|| anyhow!("The update has no checksum to verify it, so it can't be installed."))?;
        *self.pending.lock().unwrap() = Some(Pending { url, sha256: sha256.to_lowercase(), file: None });
        self.set(json!({"status": "available", "version": version, "notes": rel["body"], "checkedAt": now}));
        Ok(())
    }

    pub async fn download(&self) -> Result<()> {
        let (url, sha) = match self.pending.lock().unwrap().as_ref() {
            Some(p) if p.file.is_none() => (p.url.clone(), p.sha256.clone()),
            _ => return Ok(()),
        };
        if self.status() == "downloading" {
            return Ok(());
        }
        self.set(json!({"status": "downloading", "progress": 0}));
        match self.download_inner(&url, &sha).await {
            Ok(file) => {
                if let Some(p) = self.pending.lock().unwrap().as_mut() {
                    p.file = Some(file);
                }
                self.set(json!({"status": "downloaded", "progress": 1}));
            }
            Err(e) => self.set(json!({"status": "error", "error": e.to_string()})),
        }
        Ok(())
    }

    async fn download_inner(&self, url: &str, sha: &str) -> Result<PathBuf> {
        let dir = std::env::temp_dir().join(format!("ssh-os-update-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await?;
        let file = dir.join(url.rsplit('/').next().unwrap_or("update.bin"));
        let res = self.http.get(url).timeout(std::time::Duration::from_secs(1800)).send().await?.error_for_status()?;
        let total = res.content_length().unwrap_or(0);
        let mut stream = res.bytes_stream();
        let mut out = tokio::fs::File::create(&file).await?;
        let mut hasher = Sha256::new();
        let (mut done, mut last) = (0u64, 0u64);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            hasher.update(&chunk);
            out.write_all(&chunk).await?;
            done += chunk.len() as u64;
            let now = crate::store::now_ms();
            if total > 0 && now - last > 150 {
                last = now;
                self.set(json!({"progress": done as f64 / total as f64}));
            }
        }
        out.flush().await?;
        let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if got != sha {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            bail!("The download failed its checksum. Try again.");
        }
        Ok(file)
    }

    pub fn install(&self) -> Result<()> {
        let file = self.pending.lock().unwrap().as_ref().and_then(|p| p.file.clone()).ok_or_else(|| anyhow!("Update not downloaded yet"))?;
        let exe = std::env::current_exe()?;
        let pid = std::process::id();
        #[cfg(target_os = "macos")]
        {
            // .../SSH OS.app/Contents/MacOS/ssh-os -> .../SSH OS.app
            let bundle = exe.ancestors().nth(3).ok_or_else(|| anyhow!("Unexpected app location"))?.to_path_buf();
            if bundle.extension().and_then(|e| e.to_str()) != Some("app") {
                bail!("Unexpected app location");
            }
            if bundle.starts_with("/Volumes") {
                bail!("Move SSH OS to your Applications folder first, then update.");
            }
            let parent = bundle.parent().ok_or_else(|| anyhow!("Unexpected app location"))?;
            let probe = parent.join(format!(".ssh-os-write-test-{pid}"));
            std::fs::write(&probe, b"").map_err(|_| anyhow!("No permission to replace the app in {}. Move it to Applications.", parent.display()))?;
            let _ = std::fs::remove_file(probe);
            let unpack = file.parent().unwrap().join("app");
            let st = std::process::Command::new("/usr/bin/ditto").args(["-x", "-k"]).arg(&file).arg(&unpack).status()?;
            if !st.success() {
                bail!("Could not unpack the update");
            }
            let new_app = std::fs::read_dir(&unpack)?.flatten().map(|e| e.path()).find(|p| p.extension().and_then(|e| e.to_str()) == Some("app")).ok_or_else(|| anyhow!("The update contains no app"))?;
            let script = r#"
while kill -0 "$1" 2>/dev/null; do sleep 0.3; done
T="$2"; N="$3"
rm -rf "$T.old"
if mv "$T" "$T.old" && /usr/bin/ditto "$N" "$T"; then rm -rf "$T.old"; else rm -rf "$T"; mv "$T.old" "$T"; fi
/usr/bin/xattr -cr "$T" 2>/dev/null
rm -rf "$4"
/usr/bin/open "$T"
"#;
            std::process::Command::new("/bin/sh")
                .args(["-c", script, "sh", &pid.to_string()])
                .arg(&bundle)
                .arg(&new_app)
                .arg(file.parent().unwrap())
                .spawn()?;
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // wait for us to exit, install silently, start the (updated) app again
            let ps = format!(
                "Wait-Process -Id {pid} -ErrorAction SilentlyContinue; Start-Process -FilePath '{}' -ArgumentList '/S' -Wait; Start-Process -FilePath '{}'",
                file.display().to_string().replace('\'', "''"),
                exe.display().to_string().replace('\'', "''")
            );
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .spawn()?;
        }
        let _ = exe;
        self.app.exit(0);
        Ok(())
    }
}
