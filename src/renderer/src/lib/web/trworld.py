#!/usr/bin/env python3
"""SSH OS: read a Terraria world file (.wld).

    trworld.py WORLD.wld [--json OUT.json] [--png OUT.png] [--scale N]

Writes a JSON summary (name, seed, size, difficulty, evil, special seeds, bosses
defeated, town NPCs, spawn/dungeon) and a PNG map with one pixel per tile
(--scale 2 = every second tile). Only the Python standard library is used.
Colours: TEdit (MS-PL), see trdata.json.
"""
import json
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))


class Reader:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def u8(self):
        v = self.d[self.p]
        self.p += 1
        return v

    def b(self):
        return self.u8() != 0

    def _s(self, fmt, n):
        v = struct.unpack_from(fmt, self.d, self.p)[0]
        self.p += n
        return v

    def i16(self):
        return self._s("<h", 2)

    def u16(self):
        return self._s("<H", 2)

    def i32(self):
        return self._s("<i", 4)

    def u32(self):
        return self._s("<I", 4)

    def i64(self):
        return self._s("<q", 8)

    def u64(self):
        return self._s("<Q", 8)

    def f32(self):
        return self._s("<f", 4)

    def f64(self):
        return self._s("<d", 8)

    def s(self):
        # .NET BinaryWriter string: 7-bit encoded length, UTF-8
        n, shift = 0, 0
        while True:
            c = self.u8()
            n |= (c & 0x7F) << shift
            shift += 7
            if c < 0x80:
                break
        v = self.d[self.p:self.p + n].decode("utf-8", "replace")
        self.p += n
        return v


TOWN_NPCS = {
    17: "Merchant", 37: "Old Man", 18: "Nurse", 19: "Arms Dealer", 20: "Dryad", 22: "Guide", 38: "Demolitionist",
    54: "Clothier", 107: "Goblin Tinkerer", 108: "Wizard", 124: "Mechanic", 142: "Santa Claus",
    160: "Truffle", 178: "Steampunker", 207: "Dye Trader", 208: "Party Girl", 209: "Cyborg",
    227: "Painter", 228: "Witch Doctor", 229: "Pirate", 353: "Stylist", 368: "Traveling Merchant",
    369: "Angler", 441: "Tax Collector", 453: "Skeleton Merchant", 550: "Tavernkeep", 588: "Golfer",
    633: "Zoologist", 637: "Town Cat", 638: "Town Dog", 656: "Town Bunny", 663: "Princess",
    670: "Nerdy Slime", 678: "Cool Slime", 679: "Elder Slime", 680: "Clumsy Slime", 681: "Diva Slime",
    682: "Surly Slime", 683: "Mystic Slime", 684: "Squire Slime",
}
DIFFICULTY = {0: "Classic", 1: "Expert", 2: "Master", 3: "Journey"}


def read_header(r):
    h = {}
    h["version"] = r.i32()
    magic = r.d[r.p:r.p + 7]
    if h["version"] >= 135:
        if magic != b"relogic":
            raise ValueError("Not a Terraria world file")
        r.p += 7
        h["fileType"] = r.u8()
        r.u32()  # revision
        r.u64()  # favourite flags
    n = r.i16()
    h["sections"] = [r.i32() for _ in range(n)]
    n = r.i16()
    imp, byte, bit = [], 0, 128
    for _ in range(n):
        if bit == 128:
            byte = r.u8()
            bit = 1
        else:
            bit <<= 1
        imp.append((byte & bit) != 0)
    h["important"] = imp
    return h


def read_info(r, v, end):
    w = {}
    w["name"] = r.s()
    w["seed"] = r.s() if v >= 179 else ""
    if v >= 181:
        r.u64()
        r.p += 16  # GUID
    w["id"] = r.i32()
    r.i32(); r.i32(); r.i32(); r.i32()  # world bounds in pixels
    w["height"] = r.i32()
    w["width"] = r.i32()
    if v >= 209:
        w["gameMode"] = r.i32()
    else:
        w["gameMode"] = 1 if (v >= 112 and r.b()) else 0
    w["difficulty"] = DIFFICULTY.get(w["gameMode"], str(w["gameMode"]))
    special = []
    for ver, key, label in (
        (222, "drunk", "Drunk world (05162020)"),
        (227, "worthy", "For the worthy"),
        (238, "anniversary", "Celebrationmk10"),
        (239, "constant", "The Constant"),
        (241, "bees", "Not the bees"),
        (249, "remix", "Don't dig up"),
        (266, "notraps", "No traps"),
        (267, "zenith", "Get fixed boi (zenith)"),
    ):
        if v >= ver and r.b():
            special.append(label)
    if v > 279:
        # Terraria 1.4.5 (file version 300+): one more secret-seed flag
        if r.b():
            special.append("Skyblock / new 1.4.5 seed")
    if v >= 141:
        r.i64()  # creation time (DateTime.ToBinary)
    if v > 279:
        r.i64()  # 1.4.5: second timestamp (last played)
    w["special"] = special
    r.u8()  # moon type
    r.p += 4 * 3 + 4 * 4 + 4 * 3 + 4 * 4 + 4 * 3  # tree/cave backgrounds, ice/jungle/hell styles
    w["spawn"] = [r.i32(), r.i32()]
    w["surface"] = r.f64()
    w["rock"] = r.f64()
    w["time"] = r.f64()
    w["day"] = r.b()
    w["moonPhase"] = r.i32()
    w["bloodMoon"] = r.b()
    w["eclipse"] = r.b()
    w["dungeon"] = [r.i32(), r.i32()]
    w["evil"] = "Crimson" if r.b() else "Corruption"
    names = ["Eye of Cthulhu", "Eater of Worlds / Brain of Cthulhu", "Skeletron", "Queen Bee",
             "The Destroyer", "The Twins", "Skeletron Prime", None, "Plantera", "Golem", "King Slime"]
    bosses = {}
    for n in names:
        val = r.b()
        if n:
            bosses[n] = val
    saved = {}
    for n in ("Goblin Tinkerer", "Wizard", "Mechanic"):
        saved[n] = r.b()
    events = {}
    for n in ("Goblin Army", "Clown", "Frost Legion", "Pirates"):
        events[n] = r.b()
    w["shadowOrbSmashed"] = r.b()
    r.b()  # meteor pending
    w["shadowOrbs"] = r.u8()
    w["altarsSmashed"] = r.i32()
    w["hardmode"] = r.b()
    w["bosses"] = bosses
    w["savedNpcs"] = saved
    w["events"] = events
    w["sizeName"] = "Small" if w["width"] <= 4200 else "Medium" if w["width"] <= 6400 else "Large"
    return w


def read_npcs(r, v):
    out = []
    if v >= 268:
        for _ in range(r.i32()):
            r.i32()
    while r.b():
        t = r.i32() if v >= 190 else None
        if t is None:
            r.s()
        name = r.s()
        x, y = r.f32(), r.f32()
        homeless = r.b()
        hx, hy = r.i32(), r.i32()
        if v >= 213:
            flags = r.u8()
            if flags & 1:
                r.i32()
        if v > 279:
            r.u8()  # 1.4.5: extra per-NPC byte
        out.append({"type": t, "kind": TOWN_NPCS.get(t, f"NPC {t}"), "name": name,
                    "x": int(x // 16), "y": int(y // 16), "homeless": homeless, "home": [hx, hy]})
    return out


def rgb(h):
    return bytes.fromhex(h) if h else None


def render(r, h, w, data, scale):
    W, H = w["width"], w["height"]
    imp = h["important"]
    g = data["g"]
    tc = [rgb(c) for c in data["tiles"]]
    wc = [rgb(c) for c in data["walls"]]
    water, lava, honey, shimmer = rgb(g["water"]), rgb(g["lava"]), rgb(g["honey"]), rgb(g["shimmer"])
    # background by depth: sky, dirt layer, cavern layer, underworld
    sky, earth, rock, hell = rgb(g["sky"]), rgb(g["earth"]), rgb(g["rock"]), rgb(g["hell"])
    surf, rl = int(w["surface"]), int(w["rock"])
    template = bytearray()
    for y in range(H):
        template += sky if y < surf else earth if y < rl else rock if y < H - 200 else hell
    fallback = b"\xff\x00\xff"
    out = bytearray(W * H * 3)
    stride = W * 3
    d = r.d
    p = r.p
    unpack = struct.unpack_from
    for x in range(W):
        col = bytearray(template)
        y = 0
        while y < H:
            h1 = d[p]; p += 1
            h2 = h3 = 0
            if h1 & 1:
                h2 = d[p]; p += 1
                if h2 & 1:
                    h3 = d[p]; p += 1
                    if h3 & 1:
                        p += 1  # header 4 (coatings)
            c = None
            if h1 & 2:
                if h1 & 32:
                    t = d[p] | (d[p + 1] << 8); p += 2
                else:
                    t = d[p]; p += 1
                if t < len(imp) and imp[t]:
                    p += 4
                if h3 & 8:
                    p += 1
                c = tc[t] if t < len(tc) else fallback
                c = c or fallback
            if h1 & 4:
                wall = d[p]; p += 1
                if h3 & 16:
                    p += 1
            else:
                wall = 0
            lq = (h1 & 0x18) >> 3
            if lq:
                p += 1
                if c is None:
                    c = shimmer if h3 & 0x80 else water if lq == 1 else lava if lq == 2 else honey
            if h3 & 64:
                wall |= d[p] << 8; p += 1
            if c is None and wall:
                c = wc[wall] if wall < len(wc) else None
            k = h1 >> 6
            if k == 0:
                n = 1
            elif k == 1:
                n = d[p] + 1; p += 1
            else:
                n = unpack("<h", d, p)[0] + 1; p += 2
            if c is not None:
                col[y * 3:(y + n) * 3] = c * n
            y += n
        o = x * 3
        out[o::stride] = col[0::3]
        out[o + 1::stride] = col[1::3]
        out[o + 2::stride] = col[2::3]
    r.p = p
    if scale > 1:
        W2, H2 = W // scale, H // scale
        small = bytearray(W2 * H2 * 3)
        for yy in range(H2):
            row = out[(yy * scale) * stride:(yy * scale + 1) * stride]
            r2 = bytearray(W2 * 3)
            r2[0::3] = row[0::3 * scale][:W2]
            r2[1::3] = row[1::3 * scale][:W2]
            r2[2::3] = row[2::3 * scale][:W2]
            small[yy * W2 * 3:(yy + 1) * W2 * 3] = r2
        return small, W2, H2
    return out, W, H


def png(path, pix, W, H):
    raw = bytearray()
    stride = W * 3
    for y in range(H):
        raw += b"\x00"
        raw += pix[y * stride:(y + 1) * stride]

    def chunk(t, b):
        c = t + b
        return struct.pack(">I", len(b)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 6)))
        f.write(chunk(b"IEND", b""))
    os.replace(tmp, path)


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        sys.exit(2)
    world = a[0]
    opt = {a[i]: a[i + 1] for i in range(1, len(a) - 1, 2)}
    data = json.load(open(os.path.join(HERE, "trdata.json")))
    with open(world, "rb") as f:
        r = Reader(f.read())
    h = read_header(r)
    v = h["version"]
    sec = h["sections"]
    r.p = sec[0]
    w = read_info(r, v, sec[1])
    w["fileVersion"] = v
    w["file"] = os.path.basename(world)
    w["modified"] = int(os.path.getmtime(world))
    try:
        r.p = sec[4]
        w["npcs"] = read_npcs(r, v)
    except Exception:
        w["npcs"] = []
    if "--png" in opt:
        scale = max(1, int(opt.get("--scale", "1")))
        r.p = sec[1]
        pix, W, H = render(r, h, w, data, scale)
        w["mapOk"] = r.p == sec[2]
        w["mapScale"] = scale
        png(opt["--png"], pix, W, H)
    txt = json.dumps(w)
    if "--json" in opt:
        tmp = opt["--json"] + ".tmp"
        with open(tmp, "w") as f:
            f.write(txt)
        os.replace(tmp, opt["--json"])
    else:
        print(txt)


if __name__ == "__main__":
    main()
