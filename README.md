# SSH OS

**[Website & downloads](https://en-code23.github.io/ssh-os/)** · macOS & Windows

A macOS-style desktop for managing your servers. Native app for macOS and Windows built with [Tauri](https://tauri.app): about a 6 MB download.
It started as a rewrite of [cube-ssh](https://github.com/Mhyar-nsi/cube-ssh).

## Features

- **Multiple servers** — save as many as you like, connect to several at once, switch from the menu bar, Finder sidebar, Dock or Spotlight. Import hosts from `~/.ssh/config`.
- **SSH, SFTP, FTP, FTPS** — password, key file (with passphrase) or ssh-agent auth. Passwords are encrypted with the macOS Keychain (`safeStorage`). SSH host keys are pinned on first connect, and a changed key blocks the connection.
- **Finder** — icon, list and column views. Sidebar favorites, back/forward, path bar and search. Drag and drop from macOS to upload, drag between folders or servers to move or copy, and copy/cut/paste across servers. Rename, duplicate, compress and extract, Get Info with chmod, Quick Look (space), "Open with Mac App", download, marquee selection and type-to-select.
- **Terminal** — xterm.js with tabs (each tab can be a different server), themes and clickable links.
- **Code Editor** — CodeMirror 6 with syntax highlighting for ~20 languages, tabs, ⌘S, and unsaved-changes guards.
- **Activity Monitor** — live CPU, memory and network graphs, a process list with quit or force quit, disks, and **systemd services** (start, stop, restart, logs).
- **Console** — journal, kernel, syslog, auth, nginx and custom log files, with live streaming and a filter.
- **Network Utility** — interface info, ping, traceroute, port scan, DNS lookup and HTTP timing, all run *from* the server.
- **Shortcuts** — one-click saved commands, either global or per server; run inline or in a Terminal.
- **System Settings** — light/dark/auto appearance, accent color, wallpapers, Dock size and magnification, terminal font and theme.

## Develop

Needs Node 20+ and Rust (stable).

```bash
npm install
npm run dev          # Tauri dev app with hot reload
npm run typecheck
npm run build        # release app + installers in src-tauri/target/release/bundle
```

### Architecture

- `src/renderer`: the React UI (desktop, window manager, Dock, menu bar, Spotlight, all apps).
- `src/renderer/src/tauri-bridge.ts`: `window.api` on top of Tauri IPC/events. It also handles native file drops and window controls.
- `src-tauri/src`: the Rust backend.
  - `remote.rs`: SSH via `russh`, SFTP via `russh-sftp`, FTP/FTPS via `suppaftp`, plus exec, streams and terminals.
  - `transfers.rs`: uploads, downloads and copies between servers.
  - `store.rs`: settings and servers. Passwords live in the OS keychain.
  - `ipc.rs`: the IPC dispatcher.
  - `updater.rs`: self-updater (GitHub releases + SHA-256 verification).
  - `lib.rs`: menu and window setup.


## Minecraft Servers app

When SSH OS finds a Minecraft Java server on a connected machine, a **Minecraft Servers** app appears in the Dock. It looks for any `server.properties` up to 4 levels deep under `~`, `/opt`, `/srv`, `/home`, `/var/games`, `/mnt` and `/data`. You can set it to always show in System Settings → Desktop & Dock.

- **Create servers:** a wizard sets up Paper (recommended), Purpur, Folia, Fabric or Vanilla for any version. It downloads Java (Eclipse Temurin, no sudo) when needed and verifies checksums. It also sets memory, gameplay and access settings, an initial operator, and asks you to accept the EULA.
- **Manage servers:**
  - Start, stop and restart, with a warning countdown, in a tmux/screen session (or in the background).
  - Restart on crash, start on boot, and scheduled restarts.
  - A live console with command history.
- **Every setting:** a typed `server.properties` editor with help for each key. Startup and Java options (memory, Aikar's or Paper's flags, custom start command). Quick access to bukkit, spigot, paper and purpur configs.
- **Add-ons:** search and install plugins, mods, data packs and resource packs from **Modrinth**, **Hangar** and **SpigotMC** (Spiget). It installs required dependencies, enables or disables add-ons, checks for updates by file hash, and updates in one click. External SpigotMC/Hangar downloads are looked up on GitHub releases.
- **Automatic updates:** `.sshos/update.py` runs from cron and updates the server jar (newest build of the same version, optionally new Minecraft versions) and add-ons. It keeps old jars for rollback, and can restart afterwards or apply the update at the next restart.
- **Backups:** world or full backups on a schedule with retention. The server pauses saving while a backup runs. You can restore (the previous files are kept), download or delete backups.
- **Players and worlds:**
  - Ops, whitelist and bans, live or offline (the app looks up UUIDs with Mojang).
  - Online players with kick, ban, game mode and message actions.
  - Switch, reset, download or upload worlds, and edit game rules (both old and 26.x rule names).
- **Delete a server:** you must type the server name to confirm. It stops the server, removes its cron jobs and deletes the folder.

Everything SSH OS adds lives in `<server>/.sshos/`. The scripts are plain `sh` and `python3`, so you can also run them yourself, e.g. `sh .sshos/ctl.sh restart`.

## Download

Get the latest build from the [website](https://en-code23.github.io/ssh-os/) or the [Releases page](https://github.com/en-code23/ssh-os/releases/latest):

- macOS Apple Silicon: `SSH-OS-mac-arm64.dmg`
- macOS Intel: `SSH-OS-mac-x64.dmg`
- Windows 10/11: `SSH-OS-Setup-x64.exe`

The app updates itself (`src-tauri/src/updater.rs`). It checks GitHub for a new release at startup and every 6 hours, downloads the file for your platform, and verifies the SHA-256 checksum that GitHub publishes for every release file; it refuses to install anything without one. You can change this under System Settings → Software Update.

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when a `v*` tag is pushed. No secrets are needed. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` first.

On Windows the shortcuts use Ctrl instead of ⌘. A few shortcuts that would clash with shell keys in the terminal are different on Windows, e.g. Ctrl+Shift+T for a new tab and Ctrl+Alt+N for a new Finder window.
