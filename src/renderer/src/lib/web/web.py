#!/usr/bin/env python3
"""SSH OS server website.

    web.py SERVER_DIR

Serves a password-protected HTTPS dashboard for a Minecraft or Terraria server that
SSH OS manages. Settings live in SERVER_DIR/.sshos/web/web.json (port, PBKDF2 password
hashes) next to a self-signed certificate (cert.pem/key.pem). Two passwords: the
player password shows status, players online, the world and its map; the admin
password also shows characters, inventories, statistics and the console log.
The site is read-only: it never sends commands that change the server.
Only the Python standard library is used.
"""
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)

DIR = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
WEB = os.path.join(DIR, ".sshos", "web")
CACHE = os.path.join(WEB, "cache")
os.makedirs(CACHE, exist_ok=True)


def load_cfg():
    with open(os.path.join(WEB, "web.json")) as f:
        return json.load(f)


CFG = load_cfg()
GAME = CFG.get("game", "minecraft")
SESSIONS = {}  # token -> (role, expires)
FAILS = {}  # ip -> (count, locked_until, last_failure)
INFLIGHT = {}  # ip -> login checks running right now
GLOBAL = {"t": 0.0, "n": 0}  # login attempts in the current second (all clients)
LOCK = threading.Lock()


# ------------------------------------------------------------------ helpers


def read(path, default=""):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return default


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def props(path):
    out = {}
    for line in read(path).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def check_password(pw, rec):
    if not rec or not pw:
        return False
    try:
        salt = bytes.fromhex(rec["salt"])
        want = bytes.fromhex(rec["hash"])
        got = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, int(rec.get("iter", 200000)), len(want))
        return hmac.compare_digest(got, want)
    except (KeyError, ValueError, TypeError):
        return False


def server_running():
    try:
        pid = int(read(os.path.join(DIR, ".sshos", "server.pid")).strip())
        os.kill(pid, 0)
        st = os.stat("/proc/%d" % pid)
        return pid, st.st_mtime
    except (ValueError, OSError):
        return None, None


def game_config():
    return read_json(os.path.join(DIR, ".sshos", "tr.json" if GAME == "terraria" else "mc.json"), {}) or {}


# ------------------------------------------------------------------ online players


def mc_ping(port):
    """Minecraft Server List Ping on localhost: returns (online, max, names, version)."""

    def varint(n):
        out = b""
        while True:
            b = n & 0x7F
            n >>= 7
            out += bytes([b | (0x80 if n else 0)])
            if not n:
                return out

    def read_varint(s):
        n, shift = 0, 0
        while True:
            b = s.recv(1)
            if not b:
                raise OSError("closed")
            n |= (b[0] & 0x7F) << shift
            shift += 7
            if not b[0] & 0x80:
                return n

    with socket.create_connection(("127.0.0.1", port), timeout=3) as s:
        host = b"localhost"
        hs = varint(0) + varint(767) + varint(len(host)) + host + struct.pack(">H", port) + varint(1)
        s.sendall(varint(len(hs)) + hs)
        s.sendall(varint(1) + varint(0))
        read_varint(s)
        read_varint(s)
        n = read_varint(s)
        data = b""
        while len(data) < n:
            chunk = s.recv(n - len(data))
            if not chunk:
                break
            data += chunk
    j = json.loads(data.decode("utf-8", "replace"))
    p = j.get("players", {})
    return p.get("online", 0), p.get("max", 0), [x.get("name", "") for x in p.get("sample", []) or []], j.get("version", {}).get("name", "")


_tr_online = {"t": 0, "v": None}


def tr_online():
    """Asks the Terraria console for the player list (cached for 20 s)."""
    if time.time() - _tr_online["t"] < 20 and _tr_online["v"] is not None:
        return _tr_online["v"]
    names, count = [], 0
    try:
        subprocess.run(["sh", os.path.join(DIR, ".sshos", "ctl.sh"), "cmd", "playing"], timeout=5, capture_output=True)
        time.sleep(1.2)
        lines = re.sub(r"\x1b\[[0-9;]*m", "", read(os.path.join(DIR, ".sshos", "console.log"))[-6000:]).splitlines()
        idx = -1
        for i in range(len(lines) - 1, -1, -1):
            if re.search(r"players? connected|Online Players", lines[i], re.I):
                idx = i
                break
        if idx >= 0:
            m = re.search(r"Online Players \((\d+)/\d+\):?\s*(.*)", lines[idx], re.I)
            if m:
                count = int(m.group(1))
                names = [x.strip() for x in m.group(2).split(",") if x.strip()]
            else:
                m = re.search(r"(\d+) players? connected", lines[idx], re.I)
                count = int(m.group(1)) if m else 0
                for i in range(idx - 1, -1, -1):
                    if len(names) >= count:
                        break
                    mm = re.match(r"^:?\s*([^\s(][^(]*?)\s*\(\d+\.\d+\.\d+\.\d+", lines[i])
                    if not mm:
                        break
                    names.insert(0, mm.group(1))
    except Exception:
        pass
    _tr_online.update(t=time.time(), v=(count, names))
    return count, names


# ------------------------------------------------------------------ world + map (background)


def world_path():
    if GAME == "terraria":
        w = props(os.path.join(DIR, "serverconfig.txt")).get("world", "")
        return w if w and os.path.isabs(w) else os.path.join(DIR, w) if w else ""
    return os.path.join(DIR, props(os.path.join(DIR, "server.properties")).get("level-name", "world") or "world")


def world_mtime():
    p = world_path()
    try:
        return os.path.getmtime(p if GAME == "terraria" else os.path.join(p, "level.dat"))
    except OSError:
        return 0


MAP = {"rendered": 0, "mtime": 0, "busy": False, "error": ""}


def render_map(force=False):
    if MAP["busy"]:
        return
    mt = world_mtime()
    if not mt or (not force and mt == MAP["mtime"] and os.path.exists(os.path.join(CACHE, "map.png"))):
        return
    MAP["busy"] = True
    try:
        script = "trworld.py" if GAME == "terraria" else "mcmap.py"
        cmd = ["nice", "-n", "19", sys.executable, os.path.join(TOOLS, script), world_path(),
               "--json", os.path.join(CACHE, "world.json"), "--png", os.path.join(CACHE, "map.png")]
        if GAME == "minecraft":
            cmd += ["--radius", str(int(CFG.get("mapRadius", 1024)))]
        r = subprocess.run(cmd, capture_output=True, timeout=900)
        MAP["error"] = r.stderr.decode("utf-8", "replace")[-400:] if r.returncode else ""
        MAP["mtime"] = mt
        MAP["rendered"] = time.time()
    except Exception as e:
        MAP["error"] = str(e)
    finally:
        MAP["busy"] = False


def map_loop():
    every = max(60, int(CFG.get("mapEvery", 600)))
    while True:
        if time.time() - MAP["rendered"] >= every or not os.path.exists(os.path.join(CACHE, "map.png")):
            render_map()
        time.sleep(30)


# ------------------------------------------------------------------ data for the pages


def status(role):
    pid, started = server_running()
    c = game_config()
    out = {"game": GAME, "title": CFG.get("title") or c.get("name") or "Server", "role": role,
           "running": bool(pid), "since": int(started) if started else None,
           "software": c.get("software", ""), "version": c.get("version", ""), "now": int(time.time())}
    if GAME == "minecraft":
        p = props(os.path.join(DIR, "server.properties"))
        port = int(p.get("server-port", "25565") or 25565)
        out.update(port=port, motd=p.get("motd", ""), maxPlayers=int(p.get("max-players", "20") or 20))
        out["players"] = []
        if pid:
            try:
                online, mx, names, ver = mc_ping(port)
                out.update(online=online, maxPlayers=mx, players=names, gameVersion=ver)
            except Exception:
                out["online"] = None
    else:
        p = props(os.path.join(DIR, "serverconfig.txt"))
        out.update(port=int(p.get("port", "7777") or 7777), motd=p.get("motd", ""), maxPlayers=int(p.get("maxplayers", "8") or 8))
        out["gameVersion"] = c.get("terraria", "")
        out["players"] = []
        if pid:
            n, names = tr_online()
            out.update(online=n, players=names)
    w = read_json(os.path.join(CACHE, "world.json"), {}) or {}
    if w and role != "admin":
        w = {k: v for k, v in w.items() if k not in ("seed", "id")}
    out["world"] = w
    out["map"] = {"ready": os.path.exists(os.path.join(CACHE, "map.png")), "busy": MAP["busy"], "rendered": int(MAP["rendered"]) or None}
    return out


def tr_players():
    import sqlite3
    data = read_json(os.path.join(TOOLS, "trdata.json"), {}) or {}
    items, prefixes = data.get("items", []), data.get("prefixes", [])
    db = os.path.join(DIR, "tshock", "tshock.sqlite")
    out = {"accounts": [], "characters": [], "ssc": bool((read_json(os.path.join(DIR, "tshock", "sscconfig.json"), {}) or {}).get("Settings", {}).get("Enabled"))}
    if not os.path.exists(db):
        out["note"] = "Character data needs TShock (accounts are stored in tshock/tshock.sqlite)."
        return out
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=3)
    try:
        cur = con.cursor()
        try:
            for row in cur.execute("SELECT ID, Username, Usergroup, Registered, LastAccessed FROM Users ORDER BY LastAccessed DESC"):
                out["accounts"].append({"id": row[0], "name": row[1], "group": row[2], "registered": row[3], "lastSeen": row[4]})
        except sqlite3.Error:
            pass
        names = {a["id"]: a["name"] for a in out["accounts"]}
        try:
            cols = [d[1] for d in cur.execute("PRAGMA table_info(tsCharacter)")]
            for row in cur.execute("SELECT * FROM tsCharacter"):
                r = dict(zip(cols, row))
                inv = []
                for i, part in enumerate(str(r.get("Inventory") or "").split("~")):
                    bits = part.split(",")
                    if len(bits) < 2:
                        continue
                    try:
                        iid, stack, pre = int(bits[0]), int(bits[1]), int(bits[2]) if len(bits) > 2 else 0
                    except ValueError:
                        continue
                    if iid <= 0 or stack <= 0:
                        continue
                    name = items[iid] if 0 <= iid < len(items) and items[iid] else "Item %d" % iid
                    pname = prefixes[pre] if 0 < pre < len(prefixes) else ""
                    inv.append({"slot": i, "id": iid, "name": (pname + " " + name).strip(), "stack": stack})
                out["characters"].append({
                    "account": names.get(r.get("Account"), "#%s" % r.get("Account")),
                    "health": r.get("Health"), "maxHealth": r.get("MaxHealth"), "mana": r.get("Mana"), "maxMana": r.get("MaxMana"),
                    "quests": r.get("questsCompleted"), "deaths": r.get("deathsPVE"), "pvpDeaths": r.get("deathsPVP"),
                    "inventory": inv,
                })
        except sqlite3.Error:
            pass
    finally:
        con.close()
    return out


def mc_players():
    import mcmap
    world = world_path()
    cache = read_json(os.path.join(DIR, "usercache.json"), []) or []
    names = {u.get("uuid"): u.get("name") for u in cache}
    ops = {o.get("uuid") for o in read_json(os.path.join(DIR, "ops.json"), []) or []}
    banned = {o.get("uuid") for o in read_json(os.path.join(DIR, "banned-players.json"), []) or []}
    out = []
    pd, sd = mcmap.player_dirs(world)
    for f in sorted(os.listdir(pd)) if os.path.isdir(pd) else []:
        if not f.endswith(".dat"):
            continue
        uuid = f[:-4]
        try:
            d = mcmap.read_nbt_file(os.path.join(pd, f))
        except Exception:
            continue
        inv = []
        for it in d.get("Inventory", []):
            iid = str(it.get("id", "")).split(":", 1)[-1]
            inv.append({"slot": it.get("Slot", 0), "name": iid.replace("_", " ").title(), "id": iid, "stack": it.get("count", it.get("Count", 1))})
        stats = (read_json(os.path.join(sd, uuid + ".json"), {}) or {}).get("stats", {})
        cu = stats.get("minecraft:custom", {})
        pos = d.get("Pos", [0, 0, 0])
        out.append({
            "uuid": uuid, "name": names.get(uuid, uuid[:8]), "op": uuid in ops, "banned": uuid in banned,
            "health": round(float(d.get("Health", 0)), 1), "food": d.get("foodLevel"), "level": d.get("XpLevel"),
            "pos": [int(pos[0]), int(pos[1]), int(pos[2])] if len(pos) == 3 else None,
            "dimension": str(d.get("Dimension", "")).split(":", 1)[-1],
            "gameMode": {0: "Survival", 1: "Creative", 2: "Adventure", 3: "Spectator"}.get(d.get("playerGameType"), ""),
            "playTimeHours": round(cu.get("minecraft:play_time", cu.get("minecraft:play_one_minute", 0)) / 72000, 1),
            "deaths": cu.get("minecraft:deaths", 0), "mobKills": cu.get("minecraft:mob_kills", 0),
            "lastSeen": int(os.path.getmtime(os.path.join(pd, f))),
            "inventory": inv,
        })
    out.sort(key=lambda p: -p["lastSeen"])
    return {"players": out}


def console_tail():
    t = read(os.path.join(DIR, ".sshos", "console.log"))
    return {"lines": re.sub(r"\x1b\[[0-9;]*m", "", t).splitlines()[-300:]}


# ------------------------------------------------------------------ HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "SSHOS"
    sys_version = ""
    timeout = 30  # drop idle connections

    def setup(self):
        # TLS handshake runs in this connection's own thread, so a slow client can't block others
        self.request.settimeout(15)
        self.request.do_handshake()
        super().setup()

    def handle(self):
        try:
            super().handle()
        except (ssl.SSLError, ConnectionError, socket.timeout, OSError):
            pass

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def role(self):
        m = re.search(r"(?:^|;\s*)sshos=([A-Za-z0-9_\-]+)", self.headers.get("Cookie", ""))
        if not m:
            return None
        with LOCK:
            s = SESSIONS.get(m.group(1))
            if not s or s[1] < time.time():
                SESSIONS.pop(m.group(1), None)
                return None
            return s[0]

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/app.css":
            return self._send(200, CSS, "text/css; charset=utf-8")
        if path == "/app.js":
            return self._send(200, JS, "application/javascript; charset=utf-8")
        role = self.role()
        if path == "/":
            return self._send(200, PAGE.replace("{{TITLE}}", html.escape(CFG.get("title") or "Server")), "text/html; charset=utf-8")
        if not role:
            return self._send(401, {"error": "login"})
        try:
            if path == "/api/status":
                return self._send(200, status(role))
            if path == "/api/map.png":
                p = os.path.join(CACHE, "map.png")
                if not os.path.exists(p):
                    return self._send(404, {"error": "no map yet"})
                with open(p, "rb") as f:
                    return self._send(200, f.read(), "image/png")
            if role != "admin":
                return self._send(403, {"error": "admin only"})
            if path == "/api/players":
                return self._send(200, tr_players() if GAME == "terraria" else mc_players())
            if path == "/api/console":
                return self._send(200, console_tail())
        except Exception as e:
            return self._send(500, {"error": str(e)[:300]})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            n = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            return self._send(400, {"error": "bad request"})
        if n < 0 or n > 4096:
            return self._send(400 if n < 0 else 413, {"error": "bad request"})
        body = parse_qs(self.rfile.read(n).decode("utf-8", "replace"))
        # same-origin check for every form post
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host", ""):
            return self._send(403, {"error": "bad origin"})
        if path == "/login":
            ip = self.client_address[0]
            now = time.time()
            busy = None
            with LOCK:
                cnt, until, last = FAILS.get(ip, (0, 0, 0))
                if now - last > 900:  # forget old failures after 15 quiet minutes
                    cnt, until = 0, 0
                if now - GLOBAL["t"] >= 1:
                    GLOBAL.update(t=now, n=0)
                GLOBAL["n"] += 1
                if until > now:
                    busy = "Too many attempts. Try again in %d s." % int(until - now + 1)
                elif INFLIGHT.get(ip, 0) >= 2 or GLOBAL["n"] > 20:
                    busy = "Too many attempts at once. Try again in a moment."
                else:
                    # count the attempt as failed *before* checking, so parallel requests
                    # can't slip past the limit; a correct password clears it again
                    cnt += 1
                    FAILS[ip] = (cnt, now + (min(300, 2 ** (cnt - 4)) if cnt >= 5 else 0), now)
                    INFLIGHT[ip] = INFLIGHT.get(ip, 0) + 1
            if busy:
                return self._send(429, {"error": busy})
            try:
                pw = (body.get("password") or [""])[0]
                role = "admin" if check_password(pw, CFG.get("admin")) else "player" if check_password(pw, CFG.get("player")) else None
            finally:
                with LOCK:
                    INFLIGHT[ip] = INFLIGHT.get(ip, 1) - 1
                    if INFLIGHT[ip] <= 0:
                        INFLIGHT.pop(ip, None)
            if not role:
                time.sleep(0.8)
                return self._send(403, {"error": "Wrong password"})
            with LOCK:
                FAILS.pop(ip, None)
                tok = secrets.token_urlsafe(32)
                ttl = 12 * 3600 if role == "admin" else 7 * 86400
                SESSIONS[tok] = (role, time.time() + ttl)
            cookie = "sshos=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Strict" % (tok, ttl)
            return self._send(200, {"role": role}, extra={"Set-Cookie": cookie})
        if path == "/logout":
            m = re.search(r"(?:^|;\s*)sshos=([A-Za-z0-9_\-]+)", self.headers.get("Cookie", ""))
            if m:
                with LOCK:
                    SESSIONS.pop(m.group(1), None)
            return self._send(200, {"ok": True}, extra={"Set-Cookie": "sshos=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"})
        if path == "/api/rerender" and self.role() == "admin":
            threading.Thread(target=render_map, args=(True,), daemon=True).start()
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not found"})


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{TITLE}}</title><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/app.js"></script></body></html>"""

CSS = r"""
:root{--bg:#0f1115;--panel:#171a21;--line:#262b35;--text:#e8eaf0;--dim:#8b93a5;--acc:#4f8cff;--ok:#34c759;--bad:#ff453a;--warn:#ffb020;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--acc)}.wrap{max-width:1180px;margin:0 auto;padding:20px 16px 60px}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}header h1{font-size:22px;margin:0}
.pill{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:99px;background:#2a2f3a;color:var(--dim)}
.pill.on{background:rgba(52,199,89,.15);color:var(--ok)}.pill.off{background:rgba(255,69,58,.15);color:var(--bad)}
nav{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:18px;overflow-x:auto}
nav button{background:none;border:0;color:var(--dim);padding:10px 14px;font:inherit;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
nav button.sel{color:var(--text);border-color:var(--acc)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card h3{margin:0 0 6px;font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
.big{font-size:26px;font-weight:700}.dim{color:var(--dim)}.small{font-size:12px}
.list{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.chip{background:#232835;border-radius:8px;padding:3px 9px;font-size:13px}
.chip.done{background:rgba(52,199,89,.15);color:var(--ok)}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}
.mapbox{position:relative;height:70vh;min-height:360px;background:#09090b;border:1px solid var(--line);border-radius:12px;overflow:hidden;cursor:grab;touch-action:none}
.mapbox canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated}
.maptools{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
button.btn{background:#232835;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer}
button.btn:hover{border-color:#3a4150}button.pri{background:var(--acc);border-color:var(--acc);color:#fff}
.login{max-width:360px;margin:12vh auto;padding:0 16px}.login .card{padding:24px}
input{width:100%;background:#0f1115;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:10px 12px;font:inherit;margin:10px 0}
.err{color:var(--bad);min-height:20px;font-size:13px}
pre{background:#0b0c10;border:1px solid var(--line);border-radius:12px;padding:12px;overflow:auto;max-height:70vh;font:12px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--dim);font-weight:600;font-size:12px}
details{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:10px}
summary{padding:12px 16px;cursor:pointer;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.inv{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px;padding:0 16px 14px}
.inv div{background:#111319;border:1px solid var(--line);border-radius:8px;padding:5px 8px;font-size:12px}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--dim)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px;vertical-align:middle}
footer{margin-top:30px;color:var(--dim);font-size:12px}
"""

JS = r"""
const $=(t,a={},...c)=>{const e=document.createElement(t);for(const[k,v]of Object.entries(a)){if(k==='class')e.className=v;else if(k==='style')e.style.cssText=v;else if(k.startsWith('on'))e.addEventListener(k.slice(2),v);else e.setAttribute(k,v)}for(const x of c.flat())if(x!=null&&x!==false)e.append(x.nodeType?x:document.createTextNode(String(x)));return e};
const app=document.getElementById('app');let S=null,tab='Overview',timer=null,mapImg=null,view=null;
const ago=s=>{if(!s)return'';const d=Math.max(0,Date.now()/1000-s);return d<60?'just now':d<3600?Math.floor(d/60)+' min ago':d<86400?Math.floor(d/3600)+' h ago':Math.floor(d/86400)+' days ago'};
const dur=s=>{s=Math.max(0,Math.floor(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+' h '+m+' min':m+' min'};
async function api(p){const r=await fetch(p,{credentials:'same-origin'});if(r.status===401){login();throw new Error('login')}if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||r.statusText);return r.json()}
function login(msg){clearInterval(timer);app.replaceChildren($('div',{class:'login'},$('div',{class:'card'},$('h2',{},document.title),$('div',{class:'dim small'},'Enter the player or admin password.'),
 $('form',{onsubmit:async e=>{e.preventDefault();const f=new FormData(e.target);const r=await fetch('/login',{method:'POST',body:new URLSearchParams(f),credentials:'same-origin'});const j=await r.json().catch(()=>({}));if(r.ok)start();else e.target.querySelector('.err').textContent=j.error||'Login failed'}},
 $('input',{type:'password',name:'password',placeholder:'Password',autocomplete:'current-password',autofocus:''}),$('div',{class:'err'},msg||''),$('button',{class:'btn pri',type:'submit'},'Log in')))))}
async function start(){try{S=await api('/api/status')}catch(e){return}render();clearInterval(timer);timer=setInterval(async()=>{try{S=await api('/api/status');if(tab==='Overview'||tab==='World')render()}catch(e){}},20000)}
function tabs(){const t=['Overview','Map','World'];if(S.role==='admin')t.push(S.game==='terraria'?'Characters':'Players','Console');return t}
function render(){
 const head=$('header',{},$('h1',{},S.title),$('span',{class:'pill '+(S.running?'on':'off')},S.running?'Online':'Offline'),$('span',{class:'dim small'},[S.software,S.version].filter(Boolean).join(' ')),
  $('span',{style:'flex:1'}),$('span',{class:'pill'},S.role==='admin'?'Admin':'Player'),$('button',{class:'btn',onclick:async()=>{await fetch('/logout',{method:'POST',credentials:'same-origin'});login()}},'Log out'));
 const nav=$('nav',{},tabs().map(t=>$('button',{class:t===tab?'sel':'',onclick:()=>{tab=t;render()}},t)));
 const body=$('div',{});app.replaceChildren($('div',{class:'wrap'},head,nav,body,$('footer',{},'Served by SSH OS · read-only')));
 ({Overview,Map:MapTab,World,Characters:People,Players:People,Console}[tab])(body)}
function Overview(el){const w=S.world||{};
 el.append($('div',{class:'grid'},
  $('div',{class:'card'},$('h3',{},'Players'),$('div',{class:'big'},S.running?(S.online==null?'?':S.online)+' / '+S.maxPlayers:'—'),$('div',{class:'list'},(S.players||[]).map(n=>$('span',{class:'chip'},n))),S.running&&!(S.players||[]).length?$('div',{class:'dim small'},'Nobody online'):null),
  $('div',{class:'card'},$('h3',{},'Status'),$('div',{class:'big'},S.running?'Running':'Stopped'),$('div',{class:'dim small'},S.running&&S.since?'Up '+dur(S.now-S.since):'')),
  $('div',{class:'card'},$('h3',{},'Version'),$('div',{class:'big'},S.gameVersion||S.version||'—'),$('div',{class:'dim small'},S.software)),
  $('div',{class:'card'},$('h3',{},'World'),$('div',{class:'big'},w.name||'—'),$('div',{class:'dim small'},S.game==='terraria'?[w.sizeName,w.difficulty,w.evil].filter(Boolean).join(' · '):[w.gameMode,w.difficulty,w.hardcore?'Hardcore':''].filter(Boolean).join(' · ')))),
  S.motd?$('div',{class:'card',style:'margin-top:12px'},$('h3',{},'Message of the day'),S.motd):null)}
function World(el){const w=S.world||{};if(!w.name){el.append($('div',{class:'card'},'The world has not been read yet. It appears a minute after the server saves.'));return}
 const rows=[['Name',w.name]];if(w.seed)rows.push(['Seed',w.seed]);
 if(S.game==='terraria'){rows.push(['Size',w.sizeName+' ('+w.width+' × '+w.height+')'],['Difficulty',w.difficulty],['Evil',w.evil],['Mode',w.hardmode?'Hardmode':'Pre-Hardmode'],['Time',w.day?'Day':'Night']);if((w.special||[]).length)rows.push(['Secret seeds',w.special.join(', ')]);if(w.bloodMoon)rows.push(['Event','Blood Moon']);if(w.eclipse)rows.push(['Event','Solar Eclipse'])}
 else{rows.push(['Game mode',w.gameMode],['Difficulty',w.difficulty+(w.hardcore?' (Hardcore)':'')],['Day',w.day],['Weather',w.thundering?'Thunderstorm':w.raining?'Rain':'Clear'],['Spawn',(w.spawn||[]).join(', ')],['Version',w.version])}
 el.append($('div',{class:'card'},rows.map(([k,v])=>$('div',{class:'row'},$('span',{class:'dim'},k),$('b',{},v==null?'':String(v))))));
 if(S.game==='terraria'){
  el.append($('div',{class:'grid',style:'margin-top:12px'},
   $('div',{class:'card'},$('h3',{},'Bosses defeated'),$('div',{class:'list'},Object.entries(w.bosses||{}).map(([n,d])=>$('span',{class:'chip'+(d?' done':'')},(d?'✓ ':'')+n)))),
   $('div',{class:'card'},$('h3',{},'Events & rescues'),$('div',{class:'list'},[...Object.entries(w.events||{}),...Object.entries(w.savedNpcs||{}).map(([n,d])=>['Rescued '+n,d])].map(([n,d])=>$('span',{class:'chip'+(d?' done':'')},(d?'✓ ':'')+n))),$('div',{class:'dim small',style:'margin-top:8px'},'Altars smashed: '+(w.altarsSmashed||0)+' · Shadow orbs: '+(w.shadowOrbs||0))),
   $('div',{class:'card'},$('h3',{},'Town NPCs'),$('div',{class:'list'},(w.npcs||[]).map(n=>$('span',{class:'chip',title:'x '+n.x+', y '+n.y},(n.name?n.name+' · ':'')+n.kind+(n.homeless?' (homeless)':'')))))))}}
function MapTab(el){
 const box=$('div',{class:'mapbox'}),cv=$('canvas',{});box.append(cv);
 const info=$('span',{class:'dim small'},S.map.busy?'Rendering the map…':S.map.rendered?'Updated '+ago(S.map.rendered):'');
 el.append($('div',{class:'maptools'},$('button',{class:'btn',onclick:()=>zoom(1.5)},'+'),$('button',{class:'btn',onclick:()=>zoom(1/1.5)},'−'),$('button',{class:'btn',onclick:()=>{view=null;draw()}},'Fit'),
  S.role==='admin'?$('button',{class:'btn',onclick:async()=>{await fetch('/api/rerender',{method:'POST',credentials:'same-origin'});info.textContent='Rendering… reload in a minute'}},'Re-render'):null,info,$('span',{style:'flex:1'}),
  $('span',{class:'legend'},$('span',{},$('span',{class:'dot',style:'background:#4f8cff'}),'Spawn'),S.game==='terraria'?$('span',{},$('span',{class:'dot',style:'background:#c084fc'}),'Dungeon'):null,S.game==='terraria'?$('span',{},$('span',{class:'dot',style:'background:#34c759'}),'Town NPC'):null)),box);
 if(!S.map.ready){box.append($('div',{style:'padding:20px',class:'dim'},'The map is being created. This takes up to a few minutes after the server first saves the world.'));return}
 const ctx=cv.getContext('2d');const w=S.world||{};
 const marks=[];if(S.game==='terraria'){if(w.spawn)marks.push([w.spawn[0],w.spawn[1],'#4f8cff','Spawn']);if(w.dungeon)marks.push([w.dungeon[0],w.dungeon[1],'#c084fc','Dungeon']);(w.npcs||[]).forEach(n=>marks.push([n.x,n.y,'#34c759',n.name||n.kind]))}
 else if(w.map&&w.spawn)marks.push([w.spawn[0]-w.map.x,w.spawn[2]-w.map.z,'#4f8cff','Spawn']);
 function size(){const r=box.getBoundingClientRect();cv.width=r.width*devicePixelRatio;cv.height=r.height*devicePixelRatio}
 window.draw=function(){if(!mapImg||!mapImg.complete)return;size();const W=cv.width,H=cv.height;if(!view){const s=Math.min(W/mapImg.width,H/mapImg.height);view={s,x:(W-mapImg.width*s)/2,y:(H-mapImg.height*s)/2}}
  ctx.fillStyle='#09090b';ctx.fillRect(0,0,W,H);ctx.imageSmoothingEnabled=view.s<1;ctx.drawImage(mapImg,view.x,view.y,mapImg.width*view.s,mapImg.height*view.s);
  for(const[x,y,c,label]of marks){const px=view.x+x*view.s,py=view.y+y*view.s;ctx.fillStyle=c;ctx.beginPath();ctx.arc(px,py,5*devicePixelRatio,0,7);ctx.fill();ctx.strokeStyle='#000';ctx.lineWidth=devicePixelRatio;ctx.stroke();if(view.s>0.6){ctx.font=12*devicePixelRatio+'px sans-serif';ctx.fillStyle='#fff';ctx.fillText(label,px+8*devicePixelRatio,py+4*devicePixelRatio)}}}
 window.zoom=function(f,cx,cy){if(!view)return;cx=cx??cv.width/2;cy=cy??cv.height/2;view.x=cx-(cx-view.x)*f;view.y=cy-(cy-view.y)*f;view.s*=f;draw()}
 let drag=null;box.addEventListener('pointerdown',e=>{drag=[e.clientX,e.clientY];box.setPointerCapture(e.pointerId)});
 box.addEventListener('pointermove',e=>{if(!drag||!view)return;view.x+=(e.clientX-drag[0])*devicePixelRatio;view.y+=(e.clientY-drag[1])*devicePixelRatio;drag=[e.clientX,e.clientY];draw()});
 box.addEventListener('pointerup',()=>drag=null);box.addEventListener('wheel',e=>{e.preventDefault();const r=box.getBoundingClientRect();zoom(e.deltaY<0?1.2:1/1.2,(e.clientX-r.left)*devicePixelRatio,(e.clientY-r.top)*devicePixelRatio)},{passive:false});
 if(!mapImg){mapImg=new Image();mapImg.onload=()=>draw();mapImg.src='/api/map.png?'+(S.map.rendered||0)}else requestAnimationFrame(draw);
 window.onresize=()=>draw()}
async function People(el){el.append($('div',{class:'dim'},'Loading…'));let d;try{d=await api('/api/players')}catch(e){el.replaceChildren($('div',{class:'card'},String(e.message)));return}el.replaceChildren();
 const inv=list=>$('div',{class:'inv'},list.length?list.map(i=>$('div',{},i.name+(i.stack>1?' ×'+i.stack:''))):$('div',{class:'dim'},'Empty'));
 if(S.game==='terraria'){
  if(d.note)el.append($('div',{class:'card'},d.note));
  if(d.accounts&&d.accounts.length)el.append($('div',{class:'card',style:'margin-bottom:12px'},$('h3',{},'Accounts ('+d.accounts.length+')'),$('table',{},$('tr',{},$('th',{},'Name'),$('th',{},'Group'),$('th',{},'Registered'),$('th',{},'Last seen')),d.accounts.map(a=>$('tr',{},$('td',{},a.name),$('td',{},a.group),$('td',{},(a.registered||'').slice(0,10)),$('td',{},(a.lastSeen||'').slice(0,16).replace('T',' ')))))));
  if(!d.ssc)el.append($('div',{class:'card dim',style:'margin-bottom:12px'},'Characters and inventories are stored on the server only when server-side characters (SSC) are on. Turn them on in SSH OS → Settings → TShock config files → sscconfig.json.'));
  d.characters.forEach(c=>el.append($('details',{},$('summary',{},$('b',{},c.account),$('span',{class:'dim'},'❤ '+c.health+'/'+c.maxHealth),$('span',{class:'dim'},'★ '+c.mana+'/'+c.maxMana),c.quests!=null?$('span',{class:'dim'},'Quests '+c.quests):null,c.deaths!=null?$('span',{class:'dim'},'Deaths '+c.deaths):null,$('span',{class:'dim'},c.inventory.length+' items')),inv(c.inventory))))}
 else{if(!d.players.length)el.append($('div',{class:'card dim'},'No players have joined yet.'));
  d.players.forEach(p=>el.append($('details',{},$('summary',{},$('b',{},p.name),p.op?$('span',{class:'pill'},'Operator'):null,p.banned?$('span',{class:'pill off'},'Banned'):null,$('span',{class:'dim'},'❤ '+p.health),$('span',{class:'dim'},'Level '+p.level),$('span',{class:'dim'},p.playTimeHours+' h played'),$('span',{class:'dim'},'Deaths '+p.deaths),$('span',{class:'dim'},p.pos?p.dimension+' '+p.pos.join(', '):''),$('span',{class:'dim small'},'seen '+ago(p.lastSeen))),inv(p.inventory))))}}
async function Console(el){const pre=$('pre',{},'Loading…');el.append(pre);try{const d=await api('/api/console');pre.textContent=d.lines.join('\n');pre.scrollTop=pre.scrollHeight}catch(e){pre.textContent=e.message}}
api('/api/status').then(s=>{S=s;start()}).catch(()=>{});
"""


def main():
    port = int(CFG.get("port", 8443))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(os.path.join(WEB, "cert.pem"), os.path.join(WEB, "key.pem"))

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        request_queue_size = 128  # default 5 resets connections when several players load the page at once

        def get_request(self):
            sock, addr = self.socket.accept()
            return ctx.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), addr

        def handle_error(self, request, client_address):
            pass  # failed handshakes / scanners: ignore quietly

    httpd = Server((CFG.get("bind", "0.0.0.0"), port), Handler)
    threading.Thread(target=map_loop, daemon=True).start()
    print("SSH OS website on https://0.0.0.0:%d for %s" % (port, DIR), flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
