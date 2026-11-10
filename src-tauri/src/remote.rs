//! Connections: SSH (russh) with SFTP, and FTP/FTPS (suppaftp).
use anyhow::{anyhow, bail, Context, Result};
use russh::client::{self, Handle, Msg};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{Channel, ChannelMsg, ChannelWriteHalf};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use suppaftp::list::File as FtpFile;
use suppaftp::tokio::{AsyncFtpStream, AsyncRustlsConnector, AsyncRustlsFtpStream};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::store::Store;

// ============================================================ helpers
pub fn pjoin(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}
pub fn pdir(p: &str) -> String {
    let t = p.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => t[..i].into(),
    }
}
pub fn pbase(p: &str) -> String {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}
pub fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn perm_string(mode: u32, kind: &str) -> String {
    let t = match kind { "dir" => 'd', "link" => 'l', _ => '-' };
    let chars = ['r', 'w', 'x'];
    let mut s = String::from(t);
    for i in 0..9 {
        s.push(if mode & (1 << (8 - i)) != 0 { chars[i % 3] } else { '-' });
    }
    s
}

/// Incremental UTF-8 decoding for terminal/stream output split across packets.
#[derive(Default)]
pub struct Utf8Buf(Vec<u8>);
impl Utf8Buf {
    pub fn push(&mut self, data: &[u8]) -> String {
        self.0.extend_from_slice(data);
        match std::str::from_utf8(&self.0) {
            Ok(s) => {
                let out = s.to_string();
                self.0.clear();
                out
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // keep an incomplete trailing sequence (max 3 bytes), drop real garbage
                let keep = if e.error_len().is_none() { self.0.len() - valid } else { 0 };
                let out = String::from_utf8_lossy(&self.0[..self.0.len() - keep]).into_owned();
                self.0 = self.0[self.0.len() - keep..].to_vec();
                out
            }
        }
    }
}

// ============================================================ SSH client handler
pub struct Client {
    host_key: String,
    known: Option<String>,
    seen: Arc<StdMutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = match key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
            russh::keys::PublicKeyOrCertificate::Certificate(c) => c.public_key().fingerprint(HashAlg::Sha256).to_string(),
        };
        *self.seen.lock().unwrap() = Some(fp.clone());
        let _ = &self.host_key;
        Ok(match &self.known {
            Some(k) => *k == fp,
            None => true,
        })
    }
}

// ============================================================ FTP
enum FtpClient {
    Plain(AsyncFtpStream),
    Tls(AsyncRustlsFtpStream),
}

macro_rules! ftp {
    ($c:expr, $s:ident => $body:expr) => {
        match $c {
            FtpClient::Plain($s) => $body,
            FtpClient::Tls($s) => $body,
        }
    };
}

pub struct Ftp {
    server: Value,
    password: Option<String>,
    client: Mutex<Option<FtpClient>>,
}

#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);
impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(&self, _: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>], _: &rustls::pki_types::ServerName<'_>, _: &[u8], _: rustls::pki_types::UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

impl Ftp {
    async fn open(&self) -> Result<FtpClient> {
        let host = self.server["host"].as_str().unwrap_or("").to_string();
        let port = self.server["port"].as_u64().unwrap_or(21) as u16;
        let user = self.server["username"].as_str().filter(|s| !s.is_empty()).unwrap_or("anonymous").to_string();
        let pass = self.password.clone().unwrap_or_else(|| if user == "anonymous" { "anonymous@".into() } else { String::new() });
        let addr = format!("{host}:{port}");
        let mut c = if self.server["protocol"] == "ftps" {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let cfg = if self.server["allowUntrusted"].as_bool().unwrap_or(false) {
                rustls::ClientConfig::builder_with_provider(provider.clone())
                    .with_safe_default_protocol_versions()?
                    .dangerous()
                    .with_custom_certificate_verifier(Arc::new(NoVerify(provider)))
                    .with_no_client_auth()
            } else {
                let mut roots = rustls::RootCertStore::empty();
                roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
                rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions()?.with_root_certificates(roots).with_no_client_auth()
            };
            let connector = AsyncRustlsConnector::from(tokio_rustls::TlsConnector::from(Arc::new(cfg)));
            let s = tokio::time::timeout(Duration::from_secs(20), AsyncRustlsFtpStream::connect(&addr)).await.context("Connection timed out.")??;
            FtpClient::Tls(s.into_secure(connector, &host).await?)
        } else {
            FtpClient::Plain(tokio::time::timeout(Duration::from_secs(20), AsyncFtpStream::connect(&addr)).await.context("Connection timed out.")??)
        };
        ftp!(&mut c, s => {
            s.login(&user, &pass).await.map_err(|e| anyhow!("Login incorrect: {e}"))?;
            s.transfer_type(suppaftp::types::FileType::Binary).await?;
        });
        Ok(c)
    }

    /// Run `f` with a live client, reconnecting once if the connection dropped.
    async fn with<T, F>(&self, f: F) -> Result<T>
    where
        F: for<'a> Fn(&'a mut FtpClient) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T>> + Send + 'a>>,
    {
        let mut g = self.client.lock().await;
        if g.is_none() {
            *g = Some(self.open().await?);
        }
        match f(g.as_mut().unwrap()).await {
            Ok(v) => Ok(v),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("connection") || msg.contains("Connection") || msg.contains("broken pipe") || msg.contains("reset") {
                    *g = Some(self.open().await?);
                    f(g.as_mut().unwrap()).await
                } else {
                    Err(e)
                }
            }
        }
    }

    fn entry(dir: &str, f: &FtpFile) -> Value {
        use suppaftp::list::PosixPexQuery as Q;
        let kind = if f.is_directory() { "dir" } else if f.is_symlink() { "link" } else { "file" };
        let mut mode = 0u32;
        for (i, who) in [Q::Owner, Q::Group, Q::Others].into_iter().enumerate() {
            let shift = 6 - 3 * i as u32;
            if f.can_read(who) { mode |= 4 << shift }
            if f.can_write(who) { mode |= 2 << shift }
            if f.can_execute(who) { mode |= 1 << shift }
        }
        let modified = f.modified().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        json!({
            "name": f.name(), "path": pjoin(dir, f.name()), "type": kind,
            "linkToDir": if kind == "link" { json!(!f.name().contains('.')) } else { Value::Null },
            "size": f.size(), "modified": modified, "mode": mode, "permissions": perm_string(mode, kind),
            "owner": f.uid().map(|u| u.to_string()), "group": f.gid().map(|g| g.to_string()),
            "hidden": f.name().starts_with('.'),
        })
    }

    async fn list(&self, path: &str) -> Result<Vec<Value>> {
        let p = path.to_string();
        let lines: Vec<String> = self.with(move |c| { let p = p.clone(); Box::pin(async move { Ok(ftp!(c, s => s.list(Some(&p)).await?)) }) }).await?;
        Ok(lines
            .iter()
            .filter_map(|l| FtpFile::try_from(l.as_str()).ok())
            .filter(|f| f.name() != "." && f.name() != "..")
            .map(|f| Self::entry(path, &f))
            .collect())
    }

    async fn read(&self, path: &str, max: usize) -> Result<Vec<u8>> {
        let p = path.to_string();
        self.with(move |c| {
            let p = p.clone();
            Box::pin(async move {
                ftp!(c, s => {
                    let mut st = s.retr_as_stream(&p).await?;
                    let mut buf = Vec::new();
                    let mut chunk = vec![0u8; 64 * 1024];
                    loop {
                        let n = st.read(&mut chunk).await?;
                        if n == 0 { break }
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.len() > max { bail!("File is too large to open") }
                    }
                    st.finish().await?;
                    Ok(buf)
                })
            })
        })
        .await
    }

    async fn write(&self, path: &str, data: Vec<u8>) -> Result<()> {
        let p = path.to_string();
        let data = Arc::new(data);
        self.with(move |c| {
            let p = p.clone();
            let data = data.clone();
            Box::pin(async move {
                ftp!(c, s => {
                    let mut st = s.put_with_stream(&p).await?;
                    st.write_all(&data).await?;
                    st.finish().await?;
                    Ok(())
                })
            })
        })
        .await
    }

    async fn simple(&self, cmd: &'static str, a: &str, b: &str) -> Result<()> {
        let (a, b) = (a.to_string(), b.to_string());
        self.with(move |c| {
            let (a, b) = (a.clone(), b.clone());
            Box::pin(async move {
                ftp!(c, s => {
                    match cmd {
                        "mkdir" => s.mkdir(&a).await?,
                        "rename" => s.rename(&a, &b).await?,
                        "rm" => s.rm(&a).await?,
                        "rmdir" => s.rmdir(&a).await?,
                        "chmod" => { s.site(format!("CHMOD {b} {a}")).await?; }
                        _ => {}
                    }
                    Ok(())
                })
            })
        })
        .await
    }

    async fn pwd(&self) -> Result<String> {
        self.with(|c| Box::pin(async move { Ok(ftp!(c, s => s.pwd().await?)) })).await
    }
}

// ============================================================ Remote FS
pub enum Fs {
    Sftp(Arc<SftpSession>),
    Ftp(Arc<Ftp>),
}

const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;

fn sftp_entry(dir: &str, name: &str, a: &FileAttributes) -> Value {
    let perm = a.permissions.unwrap_or(0);
    let kind = match perm & S_IFMT { S_IFDIR => "dir", S_IFLNK => "link", _ => "file" };
    json!({
        "name": name, "path": pjoin(dir, name), "type": kind, "size": a.size.unwrap_or(0),
        "modified": a.mtime.unwrap_or(0) as u64 * 1000, "mode": perm & 0o7777, "permissions": perm_string(perm, kind),
        "owner": a.user.clone().unwrap_or_else(|| a.uid.map(|u| u.to_string()).unwrap_or_default()),
        "group": a.group.clone().unwrap_or_else(|| a.gid.map(|g| g.to_string()).unwrap_or_default()),
        "hidden": name.starts_with('.'),
    })
}

pub type Progress<'a> = &'a (dyn Fn(u64) + Send + Sync);

impl Fs {
    pub async fn home(&self) -> Result<String> {
        match self {
            Fs::Sftp(s) => Ok(s.canonicalize(".").await?),
            Fs::Ftp(f) => f.pwd().await,
        }
    }

    pub async fn list(&self, path: &str) -> Result<Vec<Value>> {
        match self {
            Fs::Sftp(s) => {
                let mut out = Vec::new();
                for e in s.read_dir(path).await? {
                    let name = e.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let mut v = sftp_entry(path, &name, &e.metadata());
                    if v["type"] == "link" {
                        if let Ok(m) = s.metadata(pjoin(path, &name)).await {
                            v["linkToDir"] = json!(m.permissions.unwrap_or(0) & S_IFMT == S_IFDIR);
                        }
                    }
                    out.push(v);
                }
                Ok(out)
            }
            Fs::Ftp(f) => f.list(path).await,
        }
    }

    pub async fn stat(&self, path: &str) -> Result<Value> {
        match self {
            Fs::Sftp(s) => {
                let m = s.symlink_metadata(path).await?;
                let name = if path == "/" { "/".to_string() } else { pbase(path) };
                let mut v = sftp_entry(&pdir(path), &name, &m);
                v["path"] = json!(path);
                if v["type"] == "link" {
                    if let Ok(t) = s.metadata(path).await {
                        v["linkToDir"] = json!(t.permissions.unwrap_or(0) & S_IFMT == S_IFDIR);
                    }
                }
                Ok(v)
            }
            Fs::Ftp(f) => {
                if path == "/" {
                    return Ok(json!({"name": "/", "path": "/", "type": "dir", "size": 0, "modified": 0, "hidden": false}));
                }
                let name = pbase(path);
                f.list(&pdir(path)).await?.into_iter().find(|e| e["name"] == name.as_str()).ok_or_else(|| anyhow!("No such file"))
            }
        }
    }

    pub async fn read(&self, path: &str, max: usize) -> Result<Vec<u8>> {
        match self {
            Fs::Sftp(s) => {
                let mut f = s.open(path).await?;
                let mut buf = Vec::new();
                let mut chunk = vec![0u8; 256 * 1024];
                loop {
                    let n = f.read(&mut chunk).await?;
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > max {
                        bail!("File is larger than {} MB", max / 1024 / 1024);
                    }
                }
                Ok(buf)
            }
            Fs::Ftp(f) => f.read(path, max).await,
        }
    }

    pub async fn write(&self, path: &str, data: Vec<u8>) -> Result<()> {
        match self {
            Fs::Sftp(s) => {
                let mut f = s.create(path).await?;
                f.write_all(&data).await?;
                f.shutdown().await?;
                Ok(())
            }
            Fs::Ftp(f) => f.write(path, data).await,
        }
    }

    pub async fn mkdir(&self, path: &str) -> Result<()> {
        match self {
            Fs::Sftp(s) => Ok(s.create_dir(path).await?),
            Fs::Ftp(f) => f.simple("mkdir", path, "").await,
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        match self {
            Fs::Sftp(s) => Ok(s.rename(from, to).await?),
            Fs::Ftp(f) => f.simple("rename", from, to).await,
        }
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> Result<()> {
        match self {
            Fs::Sftp(s) => {
                let mut a = FileAttributes::empty();
                a.permissions = Some(mode);
                Ok(s.set_metadata(path, a).await?)
            }
            Fs::Ftp(f) => f.simple("chmod", path, &format!("{:o}", mode)).await,
        }
    }

    pub fn remove<'a>(&'a self, path: &'a str, is_dir: bool) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            if !is_dir {
                return match self {
                    Fs::Sftp(s) => Ok(s.remove_file(path).await?),
                    Fs::Ftp(f) => f.simple("rm", path, "").await,
                };
            }
            for e in self.list(path).await? {
                let p = e["path"].as_str().unwrap_or("").to_string();
                self.remove(&p, e["type"] == "dir").await?;
            }
            match self {
                Fs::Sftp(s) => Ok(s.remove_dir(path).await?),
                Fs::Ftp(f) => f.simple("rmdir", path, "").await,
            }
        })
    }

    pub async fn download(&self, remote: &str, local: &std::path::Path, progress: Progress<'_>, cancel: &(dyn Fn() -> bool + Send + Sync)) -> Result<u64> {
        let mut out = tokio::fs::File::create(local).await?;
        let mut done = 0u64;
        let mut chunk = vec![0u8; 256 * 1024];
        match self {
            Fs::Sftp(s) => {
                let mut f = s.open(remote).await?;
                loop {
                    if cancel() { bail!("Cancelled") }
                    let n = f.read(&mut chunk).await?;
                    if n == 0 { break }
                    out.write_all(&chunk[..n]).await?;
                    done += n as u64;
                    progress(done);
                }
            }
            Fs::Ftp(f) => {
                // FTP transfers hold the control connection; buffer through memory in chunks
                let data = f.read(remote, usize::MAX).await?;
                out.write_all(&data).await?;
                done = data.len() as u64;
                progress(done);
            }
        }
        out.flush().await?;
        Ok(done)
    }

    pub async fn upload(&self, local: &std::path::Path, remote: &str, progress: Progress<'_>, cancel: &(dyn Fn() -> bool + Send + Sync)) -> Result<u64> {
        match self {
            Fs::Sftp(s) => {
                let mut inp = tokio::fs::File::open(local).await?;
                let mut f = s.create(remote).await?;
                let mut chunk = vec![0u8; 256 * 1024];
                let mut done = 0u64;
                loop {
                    if cancel() { bail!("Cancelled") }
                    let n = inp.read(&mut chunk).await?;
                    if n == 0 { break }
                    f.write_all(&chunk[..n]).await?;
                    done += n as u64;
                    progress(done);
                }
                f.shutdown().await?;
                Ok(done)
            }
            Fs::Ftp(f) => {
                let data = tokio::fs::read(local).await?;
                let n = data.len() as u64;
                f.write(remote, data).await?;
                progress(n);
                Ok(n)
            }
        }
    }
}

// ============================================================ Sessions
pub struct Session {
    pub ssh: Option<Arc<Handle<Client>>>,
    pub fs: Fs,
}

struct Live {
    server_id: String,
    writer: ChannelWriteHalf<Msg>,
}

pub struct Conns {
    app: AppHandle,
    store: Arc<Store>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    states: StdMutex<HashMap<String, Value>>,
    terms: Mutex<HashMap<String, Live>>,
    streams: Mutex<HashMap<String, Live>>,
}

fn friendly(e: &anyhow::Error) -> String {
    let m = format!("{e:#}");
    if m.contains("refused") { return "Connection refused: is the server running and the port correct?".into() }
    if m.contains("failed to lookup") || m.contains("nodename nor servname") || m.contains("No such host") { return "Host not found: check the address.".into() }
    if m.contains("timed out") || m.contains("Timeout") { return "Connection timed out.".into() }
    if m.contains("unreachable") { return "Host unreachable.".into() }
    m
}

impl Conns {
    pub fn new(app: AppHandle, store: Arc<Store>) -> Arc<Self> {
        Arc::new(Self {
            app,
            store,
            sessions: Mutex::new(HashMap::new()),
            states: StdMutex::new(HashMap::new()),
            terms: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
        })
    }

    fn set_state(&self, v: Value) {
        let id = v["serverId"].as_str().unwrap_or("").to_string();
        self.states.lock().unwrap().insert(id, v.clone());
        let _ = self.app.emit("conn:state", v);
    }

    pub fn states(&self) -> Value {
        Value::Array(self.states.lock().unwrap().values().filter(|v| v["status"] == "connected").cloned().collect())
    }

    pub async fn session(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions.lock().await.get(id).cloned().ok_or_else(|| anyhow!("Not connected to this server"))
    }

    pub async fn has_exec(&self, id: &str) -> bool {
        self.sessions.lock().await.get(id).map(|s| s.ssh.is_some()).unwrap_or(false)
    }

    async fn ssh(&self, id: &str) -> Result<Arc<Handle<Client>>> {
        self.session(id).await?.ssh.clone().ok_or_else(|| anyhow!("This server is connected via FTP: shell commands need an SSH connection"))
    }

    pub async fn connect(self: &Arc<Self>, id: &str, password: Option<String>, remember: bool) -> Result<Value> {
        let server = self.store.server_with_secrets(id).ok_or_else(|| anyhow!("Unknown server"))?;
        if let Some(st) = self.states.lock().unwrap().get(id) {
            if st["status"] == "connected" && self.sessions.try_lock().map(|s| s.contains_key(id)).unwrap_or(true) {
                return Ok(st.clone());
            }
        }
        self.disconnect(id).await;
        let proto = server["protocol"].as_str().unwrap_or("ssh").to_string();
        let can_exec = proto == "ssh";
        self.set_state(json!({"serverId": id, "status": "connecting", "canExec": can_exec}));
        let pw = password.clone().filter(|p| !p.is_empty()).or_else(|| server["password"].as_str().map(String::from));
        let res = if can_exec { self.connect_ssh(id, &server, pw.clone()).await } else { self.connect_ftp(&server, pw.clone()).await };
        match res {
            Ok((session, home, fp)) => {
                let session = Arc::new(session);
                self.sessions.lock().await.insert(id.to_string(), session.clone());
                if let Some(h) = session.ssh.clone() {
                    let me = self.clone();
                    let sid = id.to_string();
                    tokio::spawn(async move {
                        loop {
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            let still = me.sessions.lock().await.get(&sid).map(|s| s.ssh.as_ref().map(|x| Arc::ptr_eq(x, &h)).unwrap_or(false)).unwrap_or(false);
                            if !still { break }
                            if h.is_closed() {
                                me.lost(&sid).await;
                                break;
                            }
                        }
                    });
                }
                if remember {
                    if let Some(p) = password.filter(|p| !p.is_empty()) {
                        let key = if server["authMethod"] == "key" { "passphrase" } else { "password" };
                        let mut s = server.clone();
                        s[key] = json!(p);
                        self.store.save_server(&s);
                    }
                }
                self.store.touch_server(id);
                let st = json!({"serverId": id, "status": "connected", "home": home, "fingerprint": fp, "canExec": can_exec});
                self.set_state(st.clone());
                Ok(st)
            }
            Err(e) => {
                let msg = friendly(&e);
                let need = msg == "NEED_PASSWORD";
                self.set_state(json!({"serverId": id, "status": if need { "disconnected" } else { "error" }, "error": msg, "canExec": false}));
                Err(anyhow!(msg))
            }
        }
    }

    async fn connect_ssh(&self, _id: &str, server: &Value, password: Option<String>) -> Result<(Session, String, Option<String>)> {
        let host = server["host"].as_str().unwrap_or("").to_string();
        let port = server["port"].as_u64().unwrap_or(22) as u16;
        let user = server["username"].as_str().unwrap_or("").to_string();
        let method = server["authMethod"].as_str().unwrap_or("password").to_string();
        let host_key = format!("{host}:{port}");
        let seen = Arc::new(StdMutex::new(None));
        let known = self.store.known_host(&host_key);
        let handler = Client { host_key: host_key.clone(), known: known.clone(), seen: seen.clone() };

        // validate credentials before connecting
        let key = if method == "key" {
            let path = server["privateKeyPath"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("No private key file selected"))?;
            let path = if let Some(rest) = path.strip_prefix("~") { format!("{}{}", dirs::home_dir().unwrap_or_default().display(), rest) } else { path.to_string() };
            let pass = server["passphrase"].as_str().map(String::from).or(password.clone());
            match load_secret_key(&path, pass.as_deref()) {
                Ok(k) => Some(k),
                Err(e) => {
                    let m = e.to_string();
                    if pass.is_none() && (m.contains("ncrypted") || m.contains("assphrase") || m.contains("decrypt")) { bail!("NEED_PASSWORD") }
                    if pass.is_some() && (m.contains("decrypt") || m.contains("assphrase")) { bail!("NEED_PASSWORD") }
                    bail!("Cannot read key file: {m}")
                }
            }
        } else {
            None
        };
        if method == "password" && password.as_deref().unwrap_or("").is_empty() {
            bail!("NEED_PASSWORD");
        }

        let cfg = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 4,
            ..Default::default()
        });
        let mut h = match tokio::time::timeout(Duration::from_secs(15), client::connect(cfg, (host.as_str(), port), handler)).await {
            Err(_) => bail!("Connection timed out."),
            Ok(Err(e)) => {
                let fp = seen.lock().unwrap().clone();
                if let (Some(k), Some(f)) = (&known, &fp) {
                    if k != f {
                        bail!("HOST KEY MISMATCH for {host_key}. The server's identity changed (got {f}). If this is expected, forget the host key in the server settings.");
                    }
                }
                return Err(anyhow!(e));
            }
            Ok(Ok(h)) => h,
        };
        let fp = seen.lock().unwrap().clone();
        if known.is_none() {
            if let Some(f) = &fp {
                self.store.set_known_host(&host_key, Some(f));
            }
        }

        let ok = match method.as_str() {
            "key" => {
                let hash = h.best_supported_rsa_hash().await?.flatten();
                h.authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key.unwrap()), hash)).await?.success()
            }
            "agent" => agent_auth(&mut h, &user).await?,
            _ => {
                let pw = password.clone().unwrap_or_default();
                let mut ok = h.authenticate_password(&user, &pw).await?.success();
                if !ok {
                    // keyboard-interactive with the same password
                    let mut r = h.authenticate_keyboard_interactive_start(&user, None).await?;
                    for _ in 0..4 {
                        match r {
                            client::KeyboardInteractiveAuthResponse::Success => { ok = true; break }
                            client::KeyboardInteractiveAuthResponse::Failure { .. } => break,
                            client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                                r = h.authenticate_keyboard_interactive_respond(prompts.iter().map(|_| pw.clone()).collect()).await?;
                            }
                        }
                    }
                }
                ok
            }
        };
        if !ok {
            if method == "password" { bail!("Authentication failed: wrong username or password") }
            if method == "agent" { bail!("Authentication failed: the SSH agent has no key this server accepts") }
            bail!("Authentication failed: the server rejected this key")
        }
        let h = Arc::new(h);
        let ch = h.channel_open_session().await?;
        ch.request_subsystem(true, "sftp").await?;
        let sftp = SftpSession::new(ch.into_stream()).await?;
        let fs = Fs::Sftp(Arc::new(sftp));
        let home = fs.home().await.unwrap_or_else(|_| "/".into());
        Ok((Session { ssh: Some(h), fs }, home, fp))
    }

    async fn connect_ftp(&self, server: &Value, password: Option<String>) -> Result<(Session, String, Option<String>)> {
        let user = server["username"].as_str().unwrap_or("");
        if password.is_none() && !user.is_empty() && user != "anonymous" {
            bail!("NEED_PASSWORD");
        }
        let ftp = Arc::new(Ftp { server: server.clone(), password, client: Mutex::new(None) });
        let c = ftp.open().await.map_err(|e| if e.to_string().contains("530") { anyhow!("Login incorrect (FTP 530).") } else { e })?;
        *ftp.client.lock().await = Some(c);
        let home = ftp.pwd().await.unwrap_or_else(|_| "/".into());
        Ok((Session { ssh: None, fs: Fs::Ftp(ftp) }, home, None))
    }

    async fn lost(&self, id: &str) {
        self.sessions.lock().await.remove(id);
        for (tid, t) in self.terms.lock().await.drain().filter(|(_, t)| t.server_id == id).collect::<Vec<_>>() {
            let _ = t.writer.close().await;
            let _ = self.app.emit("term:exit", json!({"id": tid, "code": null}));
        }
        self.set_state(json!({"serverId": id, "status": "error", "error": "Connection lost", "canExec": true}));
    }

    pub async fn disconnect(&self, id: &str) {
        let s = self.sessions.lock().await.remove(id);
        let terms: Vec<String> = self.terms.lock().await.iter().filter(|(_, t)| t.server_id == id).map(|(k, _)| k.clone()).collect();
        for t in terms {
            if let Some(l) = self.terms.lock().await.remove(&t) {
                let _ = l.writer.close().await;
            }
        }
        let streams: Vec<String> = self.streams.lock().await.iter().filter(|(_, t)| t.server_id == id).map(|(k, _)| k.clone()).collect();
        for t in streams {
            if let Some(l) = self.streams.lock().await.remove(&t) {
                let _ = l.writer.close().await;
            }
        }
        if let Some(s) = s {
            if let Some(h) = &s.ssh {
                let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await;
            }
            if self.states.lock().unwrap().contains_key(id) {
                self.set_state(json!({"serverId": id, "status": "disconnected", "canExec": false}));
            }
        }
    }

    pub async fn disconnect_all(&self) {
        let ids: Vec<String> = self.sessions.lock().await.keys().cloned().collect();
        for id in ids {
            self.disconnect(&id).await;
        }
    }

    // ---------------- exec ----------------
    pub async fn exec(&self, id: &str, cmd: &str, timeout_ms: Option<u64>) -> Result<Value> {
        let h = self.ssh(id).await?;
        let mut ch = open_session(&h).await?;
        ch.exec(true, cmd).await?;
        let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), Value::Null);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(60_000));
        loop {
            match tokio::time::timeout_at(deadline, ch.wait()).await {
                Err(_) => {
                    let _ = ch.close().await;
                    break;
                }
                Ok(None) => break,
                Ok(Some(ChannelMsg::Data { data })) => out.extend_from_slice(&data),
                Ok(Some(ChannelMsg::ExtendedData { data, .. })) => err.extend_from_slice(&data),
                Ok(Some(ChannelMsg::ExitStatus { exit_status })) => code = json!(exit_status),
                Ok(Some(_)) => {}
            }
        }
        Ok(json!({"stdout": String::from_utf8_lossy(&out), "stderr": String::from_utf8_lossy(&err), "code": code}))
    }

    pub async fn start_stream(self: &Arc<Self>, id: &str, sid: &str, cmd: &str) -> Result<()> {
        let h = self.ssh(id).await?;
        let ch = open_session(&h).await?;
        ch.request_pty(false, "xterm-256color", 200, 50, 0, 0, &[]).await?;
        ch.exec(true, cmd).await?;
        let (mut rd, wr) = ch.split();
        self.streams.lock().await.insert(sid.to_string(), Live { server_id: id.to_string(), writer: wr });
        let me = self.clone();
        let sid = sid.to_string();
        tokio::spawn(async move {
            let mut dec = Utf8Buf::default();
            let mut code = Value::Null;
            while let Some(msg) = rd.wait().await {
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        let _ = me.app.emit("stream:event", json!({"id": sid, "type": "data", "data": dec.push(&data)}));
                    }
                    ChannelMsg::ExitStatus { exit_status } => code = json!(exit_status),
                    _ => {}
                }
            }
            me.streams.lock().await.remove(&sid);
            let _ = me.app.emit("stream:event", json!({"id": sid, "type": "exit", "code": code}));
        });
        Ok(())
    }

    pub async fn stop_stream(&self, sid: &str) {
        if let Some(l) = self.streams.lock().await.get(sid) {
            let _ = l.writer.data(&b"\x03"[..]).await;
            let _ = l.writer.signal(russh::Sig::INT).await;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Some(l) = self.streams.lock().await.remove(sid) {
            let _ = l.writer.close().await;
        }
    }

    // ---------------- terminals ----------------
    pub async fn open_terminal(self: &Arc<Self>, id: &str, tid: &str, cols: u32, rows: u32, cwd: Option<String>) -> Result<()> {
        let h = self.ssh(id).await?;
        let ch = open_session(&h).await?;
        ch.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await?;
        let _ = ch.set_env(false, "LANG", "en_US.UTF-8").await;
        ch.request_shell(true).await?;
        let (mut rd, wr) = ch.split();
        if let Some(c) = cwd.filter(|c| !c.is_empty()) {
            let _ = wr.data(format!("cd -- {} && clear\n", shq(&c)).as_bytes()).await;
        }
        self.terms.lock().await.insert(tid.to_string(), Live { server_id: id.to_string(), writer: wr });
        let me = self.clone();
        let tid = tid.to_string();
        tokio::spawn(async move {
            let mut dec = Utf8Buf::default();
            while let Some(msg) = rd.wait().await {
                if let ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } = msg {
                    let _ = me.app.emit("term:data", json!({"id": tid, "data": dec.push(&data)}));
                }
            }
            if me.terms.lock().await.remove(&tid).is_some() {
                let _ = me.app.emit("term:exit", json!({"id": tid, "code": null}));
            }
        });
        Ok(())
    }

    pub async fn write_terminal(&self, tid: &str, data: &str) {
        if let Some(l) = self.terms.lock().await.get(tid) {
            let _ = l.writer.data(data.as_bytes()).await;
        }
    }

    pub async fn resize_terminal(&self, tid: &str, cols: u32, rows: u32) {
        if let Some(l) = self.terms.lock().await.get(tid) {
            let _ = l.writer.window_change(cols, rows, 0, 0).await;
        }
    }

    pub async fn close_terminal(&self, tid: &str) {
        if let Some(l) = self.terms.lock().await.remove(tid) {
            let _ = l.writer.close().await;
        }
    }
}

async fn open_session(h: &Handle<Client>) -> Result<Channel<Msg>> {
    let mut last = None;
    for _ in 0..4 {
        match h.channel_open_session().await {
            Ok(c) => return Ok(c),
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
    }
    Err(anyhow!(last.unwrap()))
}

async fn agent_auth(h: &mut Handle<Client>, user: &str) -> Result<bool> {
    #[cfg(unix)]
    let mut agent = russh::keys::agent::client::AgentClient::connect_env().await.map_err(|_| anyhow!("No SSH agent available (SSH_AUTH_SOCK not set)"))?;
    #[cfg(windows)]
    let mut agent = russh::keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await.map_err(|_| anyhow!("The OpenSSH Authentication Agent service is not running"))?;
    let ids = agent.request_identities().await?;
    let hash = h.best_supported_rsa_hash().await?.flatten();
    for id in ids {
        if let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = id {
            let k: PublicKey = key;
            if h.authenticate_publickey_with(user, k, hash, &mut agent).await.map(|r| r.success()).unwrap_or(false) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
