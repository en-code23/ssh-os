//! One `ipc` command that mirrors the Electron preload API (`window.api.call(channel, ...args)`),
//! so the React UI works unchanged.
use anyhow::{anyhow, bail, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::remote::{pjoin, shq, Conns};
use crate::store::Store;
use crate::transfers::{items, Transfers};

pub struct AppState {
    pub store: Arc<Store>,
    pub conns: Arc<Conns>,
    pub transfers: Arc<Transfers>,
    pub http: reqwest::Client,
}

fn s(args: &[Value], i: usize) -> String {
    args.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

const API_HOSTS: &[&str] = &[
    "api.modrinth.com", "hangar.papermc.io", "api.spiget.org", "fill.papermc.io", "api.purpurmc.org",
    "meta.fabricmc.net", "piston-meta.mojang.com", "launchermeta.mojang.com", "api.mojang.com", "api.github.com", "api.adoptium.net",
];

pub fn apply_theme(app: &AppHandle, appearance: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(match appearance {
            "dark" => Some(tauri::Theme::Dark),
            "light" => Some(tauri::Theme::Light),
            _ => None,
        });
    }
}

fn parse_ssh_config() -> Value {
    let Some(text) = dirs::home_dir().and_then(|h| std::fs::read_to_string(h.join(".ssh").join("config")).ok()) else {
        return json!([]);
    };
    let mut hosts: Vec<Value> = Vec::new();
    let mut cur: Option<usize> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
            None => continue,
        };
        if k == "host" {
            cur = None;
            if v.contains(['*', '?', '!']) {
                continue;
            }
            let name = v.split_whitespace().next().unwrap_or("").to_string();
            hosts.push(json!({"name": name, "host": name, "port": 22, "protocol": "ssh", "authMethod": "agent"}));
            cur = Some(hosts.len() - 1);
        } else if let Some(i) = cur {
            match k.as_str() {
                "hostname" => hosts[i]["host"] = json!(v),
                "port" => hosts[i]["port"] = json!(v.parse::<u16>().unwrap_or(22)),
                "user" => hosts[i]["username"] = json!(v),
                "identityfile" => {
                    hosts[i]["privateKeyPath"] = json!(v);
                    hosts[i]["authMethod"] = json!("key");
                }
                _ => {}
            }
        }
    }
    Value::Array(hosts)
}

async fn dispatch(app: &AppHandle, st: &AppState, ch: &str, a: &[Value]) -> Result<Value> {
    let store = &st.store;
    let conns = &st.conns;
    Ok(match ch {
        // ---------------- servers
        "servers:list" => store.list_servers(),
        "servers:save" => store.save_server(a.first().unwrap_or(&Value::Null)),
        "servers:delete" => {
            conns.disconnect(&s(a, 0)).await;
            store.delete_server(&s(a, 0));
            Value::Null
        }
        "servers:importSshConfig" => parse_ssh_config(),
        "servers:forgetHostKey" => {
            store.set_known_host(&format!("{}:{}", s(a, 0), a.get(1).and_then(|v| v.as_u64()).unwrap_or(22)), None);
            Value::Null
        }
        "servers:test" => {
            let mut sv = a.first().cloned().unwrap_or(json!({}));
            if let Some(prev) = sv["id"].as_str().filter(|x| !x.is_empty()).and_then(|id| store.server_with_secrets(id)) {
                for k in ["password", "passphrase"] {
                    if sv[k].as_str().unwrap_or("").is_empty() {
                        sv[k] = prev[k].clone();
                    }
                }
            }
            let pw = sv["password"].as_str().map(String::from);
            sv["id"] = json!(format!("__test__{}", uuid::Uuid::new_v4()));
            let tmp = store.save_server(&sv);
            let id = tmp["id"].as_str().unwrap_or("").to_string();
            let r = conns.connect(&id, pw, false).await;
            conns.disconnect(&id).await;
            store.delete_server(&id);
            r?;
            json!(true)
        }
        // ---------------- connections
        "conn:connect" => {
            let o = a.get(1).cloned().unwrap_or(Value::Null);
            conns.connect(&s(a, 0), o["password"].as_str().map(String::from), o["remember"].as_bool().unwrap_or(false)).await?
        }
        "conn:disconnect" => {
            conns.disconnect(&s(a, 0)).await;
            Value::Null
        }
        "conn:states" => conns.states(),
        // ---------------- filesystem
        "fs:list" => Value::Array(conns.session(&s(a, 0)).await?.fs.list(&s(a, 1)).await?),
        "fs:stat" => conns.session(&s(a, 0)).await?.fs.stat(&s(a, 1)).await?,
        "fs:readText" => json!(String::from_utf8_lossy(&conns.session(&s(a, 0)).await?.fs.read(&s(a, 1), 10 << 20).await?)),
        "fs:readDataUrl" => {
            let b = conns.session(&s(a, 0)).await?.fs.read(&s(a, 1), 25 << 20).await?;
            json!(format!("data:{};base64,{}", s(a, 2), base64::engine::general_purpose::STANDARD.encode(b)))
        }
        "fs:writeText" => {
            conns.session(&s(a, 0)).await?.fs.write(&s(a, 1), s(a, 2).into_bytes()).await?;
            Value::Null
        }
        "fs:mkdir" => {
            conns.session(&s(a, 0)).await?.fs.mkdir(&s(a, 1)).await?;
            Value::Null
        }
        "fs:rename" => {
            conns.session(&s(a, 0)).await?.fs.rename(&s(a, 1), &s(a, 2)).await?;
            Value::Null
        }
        "fs:remove" => {
            let sess = conns.session(&s(a, 0)).await?;
            for it in items(a.get(1).unwrap_or(&Value::Null)) {
                if it.is_dir && sess.ssh.is_some() {
                    let r = conns.exec(&s(a, 0), &format!("rm -rf -- {}", shq(&it.path)), Some(600_000)).await?;
                    if r["code"] != 0 {
                        bail!("{}", r["stderr"].as_str().unwrap_or("Delete failed").trim());
                    }
                } else {
                    sess.fs.remove(&it.path, it.is_dir).await?;
                }
            }
            Value::Null
        }
        "fs:chmod" => {
            conns.session(&s(a, 0)).await?.fs.chmod(&s(a, 1), a.get(2).and_then(|v| v.as_u64()).unwrap_or(0o644) as u32).await?;
            Value::Null
        }
        "fs:diskFree" => {
            if !conns.has_exec(&s(a, 0)).await {
                return Ok(Value::Null);
            }
            let r = conns.exec(&s(a, 0), &format!("df -Pk -- {} | tail -1", shq(&s(a, 1))), None).await?;
            let parts: Vec<&str> = r["stdout"].as_str().unwrap_or("").split_whitespace().collect();
            parts.get(3).and_then(|x| x.parse::<u64>().ok()).map(|k| json!(k * 1024)).unwrap_or(Value::Null)
        }
        "fs:upload" => {
            let paths: Vec<PathBuf> = a.get(1).and_then(|v| v.as_array()).map(|v| v.iter().filter_map(|p| p.as_str().map(PathBuf::from)).collect()).unwrap_or_default();
            st.transfers.upload(conns, &s(a, 0), paths, &s(a, 2)).await?;
            Value::Null
        }
        "fs:uploadDialog" => {
            let picked = app.dialog().file().set_title("Upload").blocking_pick_files();
            let Some(files) = picked else { return Ok(json!(false)) };
            let paths: Vec<PathBuf> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
            if paths.is_empty() {
                return Ok(json!(false));
            }
            st.transfers.upload(conns, &s(a, 0), paths, &s(a, 1)).await?;
            json!(true)
        }
        "fs:download" | "fs:downloadTo" => {
            let dir = if ch == "fs:downloadTo" {
                match app.dialog().file().set_title("Download Here").blocking_pick_folder().and_then(|f| f.into_path().ok()) {
                    Some(d) => d,
                    None => return Ok(Value::Null),
                }
            } else {
                dirs::download_dir().unwrap_or_else(std::env::temp_dir)
            };
            let outs = st.transfers.download(conns, &s(a, 0), items(a.get(1).unwrap_or(&Value::Null)), dir).await?;
            if let Some(first) = outs.first() {
                let _ = app.opener().reveal_item_in_dir(first);
            }
            json!(outs.iter().map(|p| p.display().to_string()).collect::<Vec<_>>())
        }
        "fs:openLocally" => {
            let dir = std::env::temp_dir().join("ssh-os").join(uuid::Uuid::new_v4().to_string());
            let outs = st.transfers.download(conns, &s(a, 0), vec![crate::transfers::Item { path: s(a, 1), is_dir: false }], dir).await?;
            let p = outs.first().ok_or_else(|| anyhow!("Download failed"))?;
            app.opener().open_path(p.display().to_string(), None::<&str>).map_err(|e| anyhow!("{e}"))?;
            Value::Null
        }
        "fs:copy" => {
            let src = a.first().cloned().unwrap_or(Value::Null);
            let dst = a.get(1).cloned().unwrap_or(Value::Null);
            st.transfers
                .copy(conns, src["serverId"].as_str().unwrap_or(""), items(&src["items"]), dst["serverId"].as_str().unwrap_or(""), dst["dir"].as_str().unwrap_or("/"), a.get(2).and_then(|v| v.as_bool()).unwrap_or(false))
                .await?;
            Value::Null
        }
        "transfer:cancel" => {
            st.transfers.cancel(&s(a, 0));
            Value::Null
        }
        // ---------------- exec / streams / terminals
        "exec" => conns.exec(&s(a, 0), &s(a, 1), a.get(2).and_then(|v| v.as_u64())).await?,
        "stream:start" => {
            conns.start_stream(&s(a, 0), &s(a, 1), &s(a, 2)).await?;
            Value::Null
        }
        "stream:stop" => {
            conns.stop_stream(&s(a, 0)).await;
            Value::Null
        }
        "term:open" => {
            let cwd = a.get(4).and_then(|v| v.as_str()).map(String::from);
            conns.open_terminal(&s(a, 0), &s(a, 1), a.get(2).and_then(|v| v.as_u64()).unwrap_or(80) as u32, a.get(3).and_then(|v| v.as_u64()).unwrap_or(24) as u32, cwd).await?;
            Value::Null
        }
        "term:close" => {
            conns.close_terminal(&s(a, 0)).await;
            Value::Null
        }
        // ---------------- settings & misc
        "settings:get" => store.get("settings"),
        "settings:set" => {
            let v = store.patch_settings(a.first().unwrap_or(&Value::Null));
            apply_theme(app, v["appearance"].as_str().unwrap_or("auto"));
            let _ = app.emit("settings", v.clone());
            v
        }
        "commands:get" => store.get("quickCommands"),
        "commands:set" => {
            store.set("quickCommands", a.first().cloned().unwrap_or(json!([])));
            Value::Null
        }
        "dialog:pickKey" => {
            let start = dirs::home_dir().map(|h| h.join(".ssh")).unwrap_or_default();
            json!(app.dialog().file().set_directory(start).set_title("Choose Key").blocking_pick_file().and_then(|f| f.into_path().ok()).map(|p| p.display().to_string()))
        }
        "clipboard:write" => {
            app.clipboard().write_text(s(a, 0)).map_err(|e| anyhow!("{e}"))?;
            Value::Null
        }
        "shell:openExternal" => {
            let url = s(a, 0);
            if url.starts_with("https://") || url.starts_with("http://") {
                app.opener().open_url(url, None::<&str>).map_err(|e| anyhow!("{e}"))?;
            }
            Value::Null
        }
        "app:info" => json!({"version": app.package_info().version.to_string(), "electron": format!("Tauri {}", tauri::VERSION), "platform": std::env::consts::OS}),
        "path:join" => json!(a.iter().filter_map(|v| v.as_str()).fold(String::new(), |acc, p| if acc.is_empty() { p.to_string() } else { pjoin(&acc, p) })),
        "http:json" => {
            let url = s(a, 0);
            let u = reqwest::Url::parse(&url)?;
            if u.scheme() != "https" || !API_HOSTS.contains(&u.host_str().unwrap_or("")) {
                bail!("Host not allowed: {}", u.host_str().unwrap_or(""));
            }
            let o = a.get(1).cloned().unwrap_or(Value::Null);
            let mut req = if o["method"] == "POST" { st.http.post(u.clone()) } else { st.http.get(u.clone()) };
            req = req.header("Accept", "application/json");
            if !o["body"].is_null() {
                req = req.json(&o["body"]);
            }
            let res = req.send().await?;
            if res.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(Value::Null);
            }
            if !res.status().is_success() {
                bail!("{} responded {}", u.host_str().unwrap_or(""), res.status().as_u16());
            }
            res.json::<Value>().await?
        }
        #[cfg(debug_assertions)]
        "debug:log" => {
            println!("[selftest] {}", a.iter().map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).collect::<Vec<_>>().join(" "));
            Value::Null
        }
        #[cfg(debug_assertions)]
        "debug:exit" => {
            app.exit(0);
            Value::Null
        }
        _ => bail!("Unknown call: {ch}"),
    })
}

#[tauri::command]
pub async fn ipc(app: AppHandle, state: State<'_, AppState>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    dispatch(&app, &state, &channel, &args).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn term_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    state.conns.write_terminal(&id, &data).await;
    Ok(())
}

#[tauri::command]
pub async fn term_resize(state: State<'_, AppState>, id: String, cols: u32, rows: u32) -> Result<(), String> {
    state.conns.resize_terminal(&id, cols, rows).await;
    Ok(())
}
