//! Uploads, downloads and copies between servers, with progress events.
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::remote::{pbase, pdir, pjoin, shq, Conns, Fs};
use crate::store::now_ms;

pub struct Transfers {
    app: AppHandle,
    cancelled: Mutex<HashSet<String>>,
    last_emit: AtomicU64,
}

#[derive(Clone)]
pub struct Item {
    pub path: String,
    pub is_dir: bool,
}

pub fn items(v: &Value) -> Vec<Item> {
    v.as_array()
        .map(|a| a.iter().map(|i| Item { path: i["path"].as_str().unwrap_or("").into(), is_dir: i["isDir"].as_bool().unwrap_or(false) }).collect())
        .unwrap_or_default()
}

struct T<'a> {
    tr: &'a Transfers,
    v: Mutex<Value>,
    base: AtomicU64,
}

impl<'a> T<'a> {
    fn id(&self) -> String {
        self.v.lock().unwrap()["id"].as_str().unwrap_or("").to_string()
    }
    fn progress(&self, done: u64, force: bool) {
        let now = now_ms();
        let mut v = self.v.lock().unwrap();
        v["done"] = json!(done);
        if force || now - self.tr.last_emit.load(Ordering::Relaxed) > 120 {
            self.tr.last_emit.store(now, Ordering::Relaxed);
            let _ = self.tr.app.emit("transfer", v.clone());
        }
    }
    fn cancelled(&self) -> bool {
        self.tr.cancelled.lock().unwrap().contains(&self.id())
    }
    fn finish(&self, err: Option<&anyhow::Error>) {
        let id = self.id();
        let was_cancelled = self.tr.cancelled.lock().unwrap().remove(&id);
        let mut v = self.v.lock().unwrap();
        v["status"] = json!(if was_cancelled { "cancelled" } else if err.is_some() { "error" } else { "done" });
        if let Some(e) = err {
            v["error"] = json!(e.to_string());
        } else {
            v["done"] = v["total"].clone();
        }
        let _ = self.tr.app.emit("transfer", v.clone());
    }
}

fn local_size(p: &Path) -> u64 {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => std::fs::read_dir(p).map(|r| r.flatten().map(|e| local_size(&e.path())).sum()).unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

fn remote_size<'a>(fs: &'a Fs, path: &'a str, is_dir: bool) -> Pin<Box<dyn Future<Output = u64> + Send + 'a>> {
    Box::pin(async move {
        if !is_dir {
            return fs.stat(path).await.ok().and_then(|v| v["size"].as_u64()).unwrap_or(0);
        }
        let mut total = 0;
        for e in fs.list(path).await.unwrap_or_default() {
            let p = e["path"].as_str().unwrap_or("").to_string();
            total += if e["type"] == "dir" { remote_size(fs, &p, true).await } else { e["size"].as_u64().unwrap_or(0) };
        }
        total
    })
}

fn unique_local(dir: &Path, name: &str) -> PathBuf {
    let mut c = dir.join(name);
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut i = 2;
    while c.exists() {
        c = dir.join(format!("{stem} {i}{ext}"));
        i += 1;
    }
    c
}

async fn unique_remote(fs: &Fs, dir: &str, name: &str) -> String {
    let existing: HashSet<String> = fs.list(dir).await.unwrap_or_default().iter().filter_map(|e| e["name"].as_str().map(String::from)).collect();
    if !existing.contains(name) {
        return pjoin(dir, name);
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for i in 1.. {
        let n = if i == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {i}{ext}") };
        if !existing.contains(&n) {
            return pjoin(dir, &n);
        }
    }
    unreachable!()
}

fn upload_rec<'a>(fs: &'a Fs, t: &'a T<'a>, local: PathBuf, remote: String) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        if t.cancelled() {
            bail!("Cancelled");
        }
        if local.is_dir() {
            let _ = fs.mkdir(&remote).await;
            let mut entries: Vec<_> = std::fs::read_dir(&local)?.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                let n = e.file_name().to_string_lossy().to_string();
                if n == ".DS_Store" {
                    continue;
                }
                upload_rec(fs, t, e.path(), pjoin(&remote, &n)).await?;
            }
        } else {
            let start = t.base.load(Ordering::Relaxed);
            let n = fs.upload(&local, &remote, &|b| t.progress(start + b, false), &|| t.cancelled()).await?;
            t.base.store(start + n, Ordering::Relaxed);
            t.progress(start + n, false);
        }
        Ok(())
    })
}

fn download_rec<'a>(fs: &'a Fs, t: &'a T<'a>, remote: String, is_dir: bool, local: PathBuf) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        if t.cancelled() {
            bail!("Cancelled");
        }
        if is_dir {
            std::fs::create_dir_all(&local)?;
            for e in fs.list(&remote).await? {
                let name = e["name"].as_str().unwrap_or("").to_string();
                // never let a remote name escape the target directory
                if name.contains('/') || name.contains('\\') || name == ".." || name == "." {
                    continue;
                }
                download_rec(fs, t, e["path"].as_str().unwrap_or("").into(), e["type"] == "dir", local.join(&name)).await?;
            }
        } else {
            let start = t.base.load(Ordering::Relaxed);
            let n = fs.download(&remote, &local, &|b| t.progress(start + b, false), &|| t.cancelled()).await?;
            t.base.store(start + n, Ordering::Relaxed);
            t.progress(start + n, false);
        }
        Ok(())
    })
}

impl Transfers {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self { app, cancelled: Mutex::new(HashSet::new()), last_emit: AtomicU64::new(0) })
    }

    fn begin(&self, server_id: &str, kind: &str, name: &str, total: u64) -> T<'_> {
        let v = json!({"id": uuid::Uuid::new_v4().to_string(), "serverId": server_id, "kind": kind, "name": name, "total": total, "done": 0, "status": "running", "startedAt": now_ms()});
        let _ = self.app.emit("transfer", v.clone());
        T { tr: self, v: Mutex::new(v), base: AtomicU64::new(0) }
    }

    pub fn cancel(&self, id: &str) {
        self.cancelled.lock().unwrap().insert(id.to_string());
    }

    pub async fn upload(&self, conns: &Conns, id: &str, paths: Vec<PathBuf>, dir: &str) -> Result<()> {
        let s = conns.session(id).await?;
        let total = paths.iter().map(|p| local_size(p)).sum();
        let name = if paths.len() == 1 { paths[0].file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default() } else { format!("{} items", paths.len()) };
        let t = self.begin(id, "upload", &name, total);
        let mut res = Ok(());
        for p in &paths {
            let n = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if let Err(e) = upload_rec(&s.fs, &t, p.clone(), pjoin(dir, &n)).await {
                res = Err(e);
                break;
            }
        }
        t.finish(res.as_ref().err());
        res
    }

    pub async fn download(&self, conns: &Conns, id: &str, list: Vec<Item>, dir: PathBuf) -> Result<Vec<PathBuf>> {
        let s = conns.session(id).await?;
        let mut total = 0;
        for i in &list {
            total += remote_size(&s.fs, &i.path, i.is_dir).await;
        }
        let name = if list.len() == 1 { pbase(&list[0].path) } else { format!("{} items", list.len()) };
        let t = self.begin(id, "download", &name, total);
        let mut outs = Vec::new();
        let mut res = Ok(());
        std::fs::create_dir_all(&dir)?;
        for i in &list {
            let target = unique_local(&dir, &pbase(&i.path));
            outs.push(target.clone());
            if let Err(e) = download_rec(&s.fs, &t, i.path.clone(), i.is_dir, target).await {
                res = Err(e);
                break;
            }
        }
        t.finish(res.as_ref().err());
        res.map(|_| outs)
    }

    pub async fn copy(&self, conns: &Conns, src_id: &str, list: Vec<Item>, dst_id: &str, dst_dir: &str, mv: bool) -> Result<()> {
        let src = conns.session(src_id).await?;
        let dst = conns.session(dst_id).await?;
        if src_id == dst_id {
            for it in &list {
                let target = if mv { pjoin(dst_dir, &pbase(&it.path)) } else { unique_remote(&dst.fs, dst_dir, &pbase(&it.path)).await };
                if target == it.path {
                    continue;
                }
                if mv {
                    src.fs.rename(&it.path, &target).await?;
                } else if conns.has_exec(src_id).await {
                    let r = conns.exec(src_id, &format!("cp -a -- {} {}", shq(&it.path), shq(&target)), Some(600_000)).await?;
                    if r["code"] != 0 {
                        bail!("{}", r["stderr"].as_str().unwrap_or("Copy failed").trim());
                    }
                } else {
                    self.cross(&src.fs, &dst.fs, dst_id, vec![it.clone()], dst_dir).await?;
                }
            }
            return Ok(());
        }
        self.cross(&src.fs, &dst.fs, dst_id, list.clone(), dst_dir).await?;
        if mv {
            for it in &list {
                src.fs.remove(&it.path, it.is_dir).await?;
            }
        }
        Ok(())
    }

    async fn cross(&self, src: &Fs, dst: &Fs, dst_id: &str, list: Vec<Item>, dst_dir: &str) -> Result<()> {
        let tmp = std::env::temp_dir().join(format!("ssh-os-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp)?;
        let mut total = 0;
        for i in &list {
            total += remote_size(src, &i.path, i.is_dir).await;
        }
        let name = if list.len() == 1 { pbase(&list[0].path) } else { format!("{} items", list.len()) };
        let t = self.begin(dst_id, "copy", &name, total * 2);
        let res: Result<()> = async {
            let mut locals = Vec::new();
            for i in &list {
                let lp = tmp.join(pbase(&i.path));
                locals.push(lp.clone());
                download_rec(src, &t, i.path.clone(), i.is_dir, lp).await?;
            }
            for lp in locals {
                let target = unique_remote(dst, dst_dir, &lp.file_name().unwrap().to_string_lossy()).await;
                upload_rec(dst, &t, lp, target).await?;
            }
            Ok(())
        }
        .await;
        t.finish(res.as_ref().err());
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = pdir;
        res
    }
}
