//! Persistent app data (servers, settings, shortcuts, known host keys) in a JSON
//! file in the app data dir. Passwords/passphrases live in the OS keychain.
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;

const KEYRING_SERVICE: &str = "SSH OS";

pub struct Store {
    path: PathBuf,
    data: Mutex<Value>,
}

fn default_commands() -> Value {
    json!([
      { "id": "qc-uptime", "name": "Uptime", "command": "uptime", "color": "#30d158" },
      { "id": "qc-disk", "name": "Disk Usage", "command": "df -h", "color": "#0a84ff" },
      { "id": "qc-mem", "name": "Memory", "command": "free -h", "color": "#bf5af2" },
      { "id": "qc-update", "name": "Check Updates", "command": "apt list --upgradable 2>/dev/null | head -50", "color": "#ff9f0a" },
      { "id": "qc-ports", "name": "Listening Ports", "command": "ss -tulpn 2>/dev/null || netstat -tulpn", "color": "#64d2ff" },
      { "id": "qc-docker", "name": "Docker Containers", "command": "docker ps --format \"table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\"", "color": "#0a84ff" },
      { "id": "qc-temp", "name": "CPU Temperature", "command": "vcgencmd measure_temp 2>/dev/null || cat /sys/class/thermal/thermal_zone0/temp | awk '{printf \"%.1f°C\\n\", $1/1000}'", "color": "#ff453a" },
      { "id": "qc-failed", "name": "Failed Services", "command": "systemctl --failed --no-pager", "color": "#ff375f" }
    ])
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("ssh-os.json");
        let mut data: Value = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| {
                // First run: import servers/settings from the Electron version (passwords
                // were encrypted with Electron's safeStorage and can't be carried over).
                let legacy = dirs::config_dir().map(|d| d.join("SSH OS").join("ssh-os.json"));
                let mut v = legacy
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .unwrap_or_else(|| json!({}));
                if let Some(servers) = v.get_mut("servers").and_then(|s| s.as_array_mut()) {
                    for s in servers.iter_mut() {
                        if let Some(o) = s.as_object_mut() {
                            o.remove("secret");
                        }
                    }
                }
                v
            });
        let o = data.as_object_mut().expect("object");
        o.entry("servers").or_insert_with(|| json!([]));
        o.entry("quickCommands").or_insert_with(default_commands);
        o.entry("settings").or_insert_with(|| json!({}));
        o.entry("knownHosts").or_insert_with(|| json!({}));
        let s = Self { path, data: Mutex::new(data) };
        s.save();
        s
    }

    fn save(&self) {
        let d = self.data.lock().unwrap();
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(&*d).unwrap()).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    // ---------------- secrets ----------------
    fn secret(id: &str) -> Map<String, Value> {
        keyring::Entry::new(KEYRING_SERVICE, id)
            .ok()
            .and_then(|e| e.get_password().ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    fn set_secret(id: &str, sec: &Map<String, Value>) {
        if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, id) {
            if sec.values().any(|v| v.as_str().map(|s| !s.is_empty()).unwrap_or(false)) {
                let _ = e.set_password(&Value::Object(sec.clone()).to_string());
            } else {
                let _ = e.delete_credential();
            }
        }
    }

    fn public(s: &Value, sec: &Map<String, Value>) -> Value {
        let mut o = s.as_object().cloned().unwrap_or_default();
        o.insert("hasPassword".into(), json!(sec.get("password").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)));
        o.insert("hasPassphrase".into(), json!(sec.get("passphrase").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)));
        Value::Object(o)
    }

    // ---------------- servers ----------------
    pub fn list_servers(&self) -> Value {
        let d = self.data.lock().unwrap();
        let list = d["servers"].as_array().cloned().unwrap_or_default();
        drop(d);
        Value::Array(list.iter().map(|s| Self::public(s, &Self::secret(s["id"].as_str().unwrap_or("")))).collect())
    }

    /// Server config including `password` / `passphrase` from the keychain.
    pub fn server_with_secrets(&self, id: &str) -> Option<Value> {
        let d = self.data.lock().unwrap();
        let s = d["servers"].as_array()?.iter().find(|s| s["id"] == id)?.clone();
        drop(d);
        let mut o = s.as_object().cloned()?;
        for (k, v) in Self::secret(id) {
            o.insert(k, v);
        }
        Some(Value::Object(o))
    }

    pub fn save_server(&self, input: &Value) -> Value {
        let mut o = input.as_object().cloned().unwrap_or_default();
        let id = o
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut sec = Self::secret(&id);
        let clear = o.get("clearPassword").and_then(|v| v.as_bool()).unwrap_or(false);
        if clear {
            sec.remove("password");
        }
        for k in ["password", "passphrase"] {
            if let Some(v) = o.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                sec.insert(k.into(), json!(v));
            }
        }
        for k in ["password", "passphrase", "hasPassword", "hasPassphrase", "clearPassword", "secret"] {
            o.remove(k);
        }
        o.insert("id".into(), json!(id));
        if o.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0) == 0 {
            o.insert("createdAt".into(), json!(now_ms()));
        }
        Self::set_secret(&id, &sec);
        let stored = Value::Object(o);
        {
            let mut d = self.data.lock().unwrap();
            let arr = d["servers"].as_array_mut().unwrap();
            if let Some(pos) = arr.iter().position(|s| s["id"] == id.as_str()) {
                arr[pos] = stored.clone();
            } else {
                arr.push(stored.clone());
            }
        }
        self.save();
        Self::public(&stored, &sec)
    }

    pub fn touch_server(&self, id: &str) {
        {
            let mut d = self.data.lock().unwrap();
            if let Some(s) = d["servers"].as_array_mut().and_then(|a| a.iter_mut().find(|s| s["id"] == id)) {
                s["lastConnectedAt"] = json!(now_ms());
            }
        }
        self.save();
    }

    pub fn delete_server(&self, id: &str) {
        {
            let mut d = self.data.lock().unwrap();
            if let Some(a) = d["servers"].as_array_mut() {
                a.retain(|s| s["id"] != id);
            }
            if let Some(a) = d["quickCommands"].as_array_mut() {
                a.retain(|c| c["serverId"] != id);
            }
        }
        if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, id) {
            let _ = e.delete_credential();
        }
        self.save();
    }

    // ---------------- misc ----------------
    pub fn get(&self, key: &str) -> Value {
        self.data.lock().unwrap()[key].clone()
    }

    pub fn set(&self, key: &str, v: Value) {
        self.data.lock().unwrap()[key] = v;
        self.save();
    }

    pub fn patch_settings(&self, patch: &Value) -> Value {
        let out = {
            let mut d = self.data.lock().unwrap();
            if let (Some(s), Some(p)) = (d["settings"].as_object_mut(), patch.as_object()) {
                for (k, v) in p {
                    s.insert(k.clone(), v.clone());
                }
            }
            d["settings"].clone()
        };
        self.save();
        out
    }

    pub fn known_host(&self, key: &str) -> Option<String> {
        self.data.lock().unwrap()["knownHosts"][key].as_str().map(String::from)
    }

    pub fn set_known_host(&self, key: &str, fp: Option<&str>) {
        {
            let mut d = self.data.lock().unwrap();
            let kh = d["knownHosts"].as_object_mut().unwrap();
            match fp {
                Some(f) => {
                    kh.insert(key.into(), json!(f));
                }
                None => {
                    kh.remove(key);
                }
            }
        }
        self.save();
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
