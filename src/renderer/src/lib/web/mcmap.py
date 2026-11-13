#!/usr/bin/env python3
"""SSH OS: Minecraft world reader.

    mcmap.py WORLD_DIR [--json OUT.json] [--png OUT.png] [--radius BLOCKS]

Reads level.dat (name, seed, spawn, version, difficulty, time, weather) and renders a
top-down map of the overworld around spawn (one pixel per block, shaded by height,
biome-tinted) from the region files. Only the Python standard library is used.
"""
import gzip
import json
import math
import os
import struct
import sys
import zlib

# ------------------------------------------------------------------ NBT


class Nbt:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def _u(self, fmt, n):
        v = struct.unpack_from(fmt, self.d, self.p)[0]
        self.p += n
        return v

    def string(self):
        n = self._u(">H", 2)
        v = self.d[self.p:self.p + n].decode("utf-8", "replace")
        self.p += n
        return v

    def payload(self, t):
        if t == 1:
            return self._u(">b", 1)
        if t == 2:
            return self._u(">h", 2)
        if t == 3:
            return self._u(">i", 4)
        if t == 4:
            return self._u(">q", 8)
        if t == 5:
            return self._u(">f", 4)
        if t == 6:
            return self._u(">d", 8)
        if t == 7:
            n = self._u(">i", 4)
            v = self.d[self.p:self.p + n]
            self.p += n
            return v
        if t == 8:
            return self.string()
        if t == 9:
            et = self._u(">b", 1)
            n = self._u(">i", 4)
            return [self.payload(et) for _ in range(max(0, n))]
        if t == 10:
            o = {}
            while True:
                tt = self._u(">b", 1)
                if tt == 0:
                    return o
                k = self.string()
                o[k] = self.payload(tt)
        if t == 11:
            n = self._u(">i", 4)
            v = struct.unpack_from(">%di" % n, self.d, self.p)
            self.p += 4 * n
            return list(v)
        if t == 12:
            n = self._u(">i", 4)
            v = struct.unpack_from(">%dQ" % n, self.d, self.p)  # unsigned for bit maths
            self.p += 8 * n
            return v
        raise ValueError("bad NBT tag %d" % t)

    def root(self):
        t = self._u(">b", 1)
        if t != 10:
            raise ValueError("not NBT")
        self.string()
        return self.payload(10)


def read_nbt_file(path):
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return Nbt(raw).root()


# ------------------------------------------------------------------ level.dat


def level_info(world):
    d = read_nbt_file(os.path.join(world, "level.dat")).get("Data", {})
    wgs = d.get("WorldGenSettings", {})
    seed = wgs.get("seed", d.get("RandomSeed"))
    if seed is None:  # 26.x keeps world generation settings in a separate file
        for p in (os.path.join(world, "dimensions", "minecraft", "overworld", "data", "minecraft", "world_gen_settings.dat"),
                  os.path.join(world, "data", "minecraft", "world_gen_settings.dat")):
            if os.path.exists(p):
                try:
                    seed = read_nbt_file(p).get("data", {}).get("seed")
                except Exception:
                    pass
                break
    spawn = d.get("spawn", {})
    if isinstance(spawn, dict) and "pos" in spawn:
        sx, sy, sz = (spawn["pos"] + [0, 0, 0])[:3]
    else:
        sx, sy, sz = d.get("SpawnX", 0), d.get("SpawnY", 64), d.get("SpawnZ", 0)
    ver = d.get("Version", {})
    diff = {0: "Peaceful", 1: "Easy", 2: "Normal", 3: "Hard"}
    dt = d.get("DayTime", d.get("Time", 0))
    ds = d.get("difficulty_settings")
    if isinstance(ds, dict):  # 26.x
        d["Difficulty"] = {"peaceful": 0, "easy": 1, "normal": 2, "hard": 3}.get(str(ds.get("difficulty")), 2)
        d["hardcore"] = ds.get("hardcore", 0)
    mode = {0: "Survival", 1: "Creative", 2: "Adventure", 3: "Spectator"}
    return {
        "name": d.get("LevelName", ""),
        "seed": str(seed) if seed is not None else "",
        "spawn": [sx, sy, sz],
        "version": ver.get("Name", "") if isinstance(ver, dict) else "",
        "difficulty": diff.get(d.get("Difficulty", 2), str(d.get("Difficulty"))),
        "hardcore": bool(d.get("hardcore", 0)),
        "gameMode": mode.get(d.get("GameType", 0), ""),
        "day": int(dt // 24000),
        "timeOfDay": int(dt % 24000),
        "raining": bool(d.get("raining", 0)),
        "thundering": bool(d.get("thundering", 0)),
    }


# ------------------------------------------------------------------ colours

C = {
    "grass": (127, 178, 56), "plant": (0, 124, 0), "sand": (247, 233, 163), "stone": (112, 112, 112),
    "dirt": (151, 109, 77), "wood": (143, 119, 72), "water": (64, 64, 255), "snow": (255, 255, 255),
    "ice": (160, 160, 255), "lava": (255, 0, 0), "clay": (164, 168, 184), "deepslate": (100, 100, 100),
    "quartz": (255, 252, 245), "podzol": (129, 86, 49), "terracotta": (209, 177, 161), "nether": (112, 2, 0),
    "mycelium": (127, 63, 178), "unknown": (130, 130, 130), "cherry": (242, 127, 165), "mud": (87, 92, 110),
}
DYES = {
    "white": (255, 255, 255), "orange": (216, 127, 51), "magenta": (178, 76, 216), "light_blue": (102, 153, 216),
    "yellow": (229, 229, 51), "lime": (127, 204, 25), "pink": (242, 127, 165), "gray": (76, 76, 76),
    "light_gray": (153, 153, 153), "cyan": (76, 127, 153), "purple": (127, 63, 178), "blue": (51, 76, 178),
    "brown": (102, 76, 51), "green": (102, 127, 51), "red": (153, 51, 51), "black": (25, 25, 25),
}
EXACT = {
    "grass_block": "grass", "short_grass": "plant", "tall_grass": "plant", "fern": "plant", "large_fern": "plant",
    "water": "water", "bubble_column": "water", "lava": "lava", "sand": "sand", "sandstone": "sand",
    "red_sand": (216, 127, 51), "red_sandstone": (216, 127, 51), "gravel": "stone", "stone": "stone",
    "cobblestone": "stone", "andesite": "stone", "tuff": "stone", "bedrock": "stone", "granite": "dirt",
    "diorite": "quartz", "calcite": "quartz", "dirt": "dirt", "coarse_dirt": "dirt", "rooted_dirt": "dirt",
    "farmland": "dirt", "dirt_path": (148, 120, 70), "podzol": "podzol", "mycelium": "mycelium", "mud": "mud",
    "snow": "snow", "snow_block": "snow", "powder_snow": "snow", "ice": "ice", "packed_ice": "ice",
    "blue_ice": "ice", "frosted_ice": "ice", "clay": "clay", "terracotta": (216, 127, 51), "moss_block": "plant",
    "moss_carpet": "plant", "leaf_litter": (156, 118, 62), "bush": "plant", "cactus": "plant", "sugar_cane": "plant", "bamboo": "plant", "vine": "plant",
    "lily_pad": "plant", "deepslate": "deepslate", "netherrack": "nether", "cherry_leaves": "cherry",
    "pumpkin": (216, 127, 51), "melon": (127, 204, 25), "obsidian": (25, 25, 25), "glass": (230, 240, 245),
    "hay_block": (229, 229, 51), "bricks": (153, 51, 51), "torch": "wood", "chest": "wood", "magma_block": "nether",
}
BIOME_GRASS = [  # (keyword, grass tint, foliage tint)
    ("badlands", (144, 129, 77), (158, 129, 77)), ("desert", (191, 183, 85), (174, 164, 42)),
    ("savanna", (191, 183, 85), (174, 164, 42)), ("jungle", (89, 201, 60), (48, 187, 11)),
    ("swamp", (106, 112, 57), (106, 112, 57)), ("mangrove", (106, 112, 57), (141, 177, 39)),
    ("snowy", (128, 180, 151), (96, 161, 123)), ("frozen", (128, 180, 151), (96, 161, 123)),
    ("taiga", (134, 183, 131), (104, 164, 100)), ("grove", (128, 180, 151), (96, 161, 123)),
    ("dark_forest", (80, 122, 50), (89, 174, 48)), ("birch", (136, 187, 103), (107, 169, 65)),
    ("mushroom", (85, 201, 63), (43, 187, 15)), ("cherry", (182, 219, 97), (182, 219, 97)),
]
WATER_TINT = [("swamp", (97, 123, 100)), ("warm", (67, 213, 238)), ("lukewarm", (69, 173, 242)),
              ("cold", (61, 87, 214)), ("frozen", (57, 56, 201))]


def base_color(name):
    n = name.split(":", 1)[-1]
    v = EXACT.get(n)
    if v is None:
        for dye, col in DYES.items():
            if n.startswith(dye + "_") and any(k in n for k in ("wool", "concrete", "terracotta", "glass", "carpet", "bed", "shulker", "candle", "banner")):
                return col, "solid"
        if n.endswith("_leaves") or "flower" in n or n in ("poppy", "dandelion", "azure_bluet", "oxeye_daisy", "cornflower", "lily_of_the_valley", "sweet_berry_bush", "seagrass", "kelp", "kelp_plant") or "tulip" in n or "orchid" in n or "sapling" in n or "bush" in n:
            v = "plant"
        elif any(k in n for k in ("log", "wood", "planks", "fence", "door", "stairs", "slab", "sign", "barrel", "crafting", "stem", "hyphae")):
            v = "wood" if not any(k in n for k in ("stone", "brick", "deepslate", "quartz", "sandstone")) else "stone"
        elif "ore" in n or "stone" in n or "brick" in n or "cobble" in n or "andesite" in n or "basalt" in n:
            v = "stone"
        elif "ice" in n:
            v = "ice"
        elif "snow" in n:
            v = "snow"
        elif "sand" in n:
            v = "sand"
        elif "nylium" in n or "nether" in n or "crimson" in n:
            v = "nether"
        else:
            v = "unknown"
    kind = "grass" if v == "grass" else "foliage" if (v == "plant" and (n.endswith("_leaves") or n in ("vine", "short_grass", "tall_grass", "fern", "large_fern"))) else "water" if v == "water" else "solid"
    return (C[v] if isinstance(v, str) else v), kind


def tint(biome, kind, col):
    b = biome.split(":", 1)[-1]
    if kind == "water":
        for k, t in WATER_TINT:
            if k in b:
                return t
        return (63, 118, 228)
    for k, g, f in BIOME_GRASS:
        if k in b:
            return g if kind == "grass" else f
    return (121, 192, 90) if kind == "grass" else (89, 174, 48)


# ------------------------------------------------------------------ chunks


def unpack(longs, bits, count):
    if not longs:
        return [0] * count
    per = 64 // bits
    mask = (1 << bits) - 1
    out = []
    for L in longs:
        for i in range(per):
            out.append((L >> (i * bits)) & mask)
            if len(out) == count:
                return out
    return out + [0] * (count - len(out))


def read_region(path):
    with open(path, "rb") as f:
        data = f.read()
    for i in range(1024):
        off = struct.unpack_from(">I", data, i * 4)[0]
        sector, size = off >> 8, off & 0xFF
        if not sector:
            continue
        p = sector * 4096
        if p + 5 > len(data):
            continue
        length, comp = struct.unpack_from(">IB", data, p)
        raw = data[p + 5:p + 4 + length]
        try:
            if comp == 2:
                raw = zlib.decompress(raw)
            elif comp == 1:
                raw = gzip.decompress(raw)
            elif comp != 3:
                continue  # external (.mcc) or LZ4 chunks are skipped
            yield i % 32, i // 32, Nbt(raw).root()
        except Exception:
            continue


def block_name(b):
    """Palette entry: {"Name": ...}, a plain string, or 26.x forms {"id": ...} / {"": ...}."""
    if isinstance(b, dict):
        if "Name" in b:
            return b["Name"]
        if "id" in b:  # 26.x: {"id": ..., "properties": ...}
            return block_name(b["id"])
        if "" in b:
            return block_name(b[""])
        return "minecraft:air"
    return str(b)


def biome_name(b):
    return block_name(b) if isinstance(b, dict) else str(b)


def chunk_columns(ch):
    """Yields 256 (x, z, top_y, block_name, biome, water_depth) for a full chunk, or nothing."""
    st = ch.get("Status", "")
    if st and not str(st).endswith("full") and st not in ("full", "minecraft:full", "spawn", "postprocessed"):
        return None
    secs = {}
    for s in ch.get("sections", []):
        bs = s.get("block_states")
        if not bs:
            continue
        pal = [block_name(b) for b in bs.get("palette", [])]
        bio = s.get("biomes", {})
        secs[s.get("Y", 0)] = (pal, bs.get("data"), [biome_name(b) for b in bio.get("palette", ["plains"])], bio.get("data"))
    if not secs:
        return None
    ymin = ch.get("yPos", min(secs)) * 16
    hm = ch.get("Heightmaps", {})
    ws = hm.get("WORLD_SURFACE")
    of = hm.get("OCEAN_FLOOR")
    if ws is None:
        return None
    height = (max(secs) + 1) * 16 - ymin
    bits = max(1, math.ceil(math.log2(height + 1)))
    surf = unpack(ws, bits, 256)
    floor = unpack(of, bits, 256) if of else surf
    cache = {}
    out = []
    for i in range(256):
        y = ymin + surf[i] - 1
        if y < ymin:
            out.append(None)
            continue
        sy = y >> 4
        sec = secs.get(sy)
        if sec is None:
            out.append(None)
            continue
        pal, data, bpal, bdata = sec
        if sy not in cache:
            bb = max(4, math.ceil(math.log2(len(pal)))) if len(pal) > 1 else 0
            blocks = unpack(data, bb, 4096) if bb and data else None
            biob = math.ceil(math.log2(len(bpal))) if len(bpal) > 1 else 0
            bios = unpack(bdata, biob, 64) if biob and bdata else None
            cache[sy] = (blocks, bios)
        blocks, bios = cache[sy]
        x, z = i & 15, i >> 4
        ly = y & 15
        idx = (ly * 16 + z) * 16 + x
        name = pal[blocks[idx]] if blocks else pal[0]
        bidx = ((ly >> 2) * 4 + (z >> 2)) * 4 + (x >> 2)
        biome = bpal[bios[bidx]] if bios else bpal[0]
        depth = surf[i] - floor[i]
        out.append((x, z, y, name, biome, depth))
    return out


def overworld_regions(world):
    """Region folder of the overworld: 'region' (up to 1.21) or the 26.x 'dimensions/...' layout."""
    for p in (os.path.join(world, "dimensions", "minecraft", "overworld", "region"), os.path.join(world, "region")):
        if os.path.isdir(p):
            return p
    return os.path.join(world, "region")


def player_dirs(world):
    """(playerdata, stats) folders for both the old and the 26.x layout."""
    pd = os.path.join(world, "players", "data")
    if os.path.isdir(pd):
        st = os.path.join(world, "players", "stats")
        return pd, st if os.path.isdir(st) else os.path.join(world, "stats")
    return os.path.join(world, "playerdata"), os.path.join(world, "stats")


def render(world, radius):
    info = level_info(world)
    sx, _, sz = info["spawn"]
    rdir = overworld_regions(world)
    regions = []
    for f in os.listdir(rdir) if os.path.isdir(rdir) else []:
        parts = f.split(".")
        if len(parts) == 4 and parts[0] == "r" and parts[3] == "mca":
            rx, rz = int(parts[1]), int(parts[2])
            cx, cz = rx * 512 + 256, rz * 512 + 256
            if abs(cx - sx) <= radius + 256 and abs(cz - sz) <= radius + 256:
                regions.append((rx, rz, f))
    if not regions:
        return info, None, 0, 0, 0, 0
    minx = min(r[0] for r in regions) * 512
    minz = min(r[1] for r in regions) * 512
    W = (max(r[0] for r in regions) + 1) * 512 - minx
    H = (max(r[1] for r in regions) + 1) * 512 - minz
    heights = {}
    cols = {}
    for rx, rz, f in regions:
        for cx, cz, ch in read_region(os.path.join(rdir, f)):
            ch = ch.get("Level", ch)  # pre-1.18 chunks nest under Level
            try:
                colsdata = chunk_columns(ch)
            except Exception:
                colsdata = None
            if not colsdata:
                continue
            bx, bz = rx * 512 + cx * 16, rz * 512 + cz * 16
            for c in colsdata:
                if c is None:
                    continue
                x, z, y, name, biome, depth = c
                X, Z = bx + x - minx, bz + z - minz
                heights[(X, Z)] = y
                cols[(X, Z)] = (name, biome, depth)
    bg = bytes((24, 24, 27))
    pix = bytearray(bg * (W * H))
    colcache = {}
    used = [W, H, 0, 0]
    for (X, Z), (name, biome, depth) in cols.items():
        key = (name, biome)
        if key not in colcache:
            col, kind = base_color(name)
            if kind != "solid":
                col = tint(biome, kind, col)
            colcache[key] = (col, kind)
        col, kind = colcache[key]
        if kind == "water":
            f = 1.0 if depth < 3 else 0.86 if depth < 8 else 0.72 if depth < 16 else 0.6
        else:
            n = heights.get((X, Z - 1))
            y = heights[(X, Z)]
            f = 0.86 if n is None or n == y else 1.0 if y > n else 0.71
        o = (Z * W + X) * 3
        pix[o:o + 3] = bytes((min(255, int(col[0] * f)), min(255, int(col[1] * f)), min(255, int(col[2] * f))))
        used[0] = min(used[0], X); used[1] = min(used[1], Z); used[2] = max(used[2], X); used[3] = max(used[3], Z)
    if used[2] < used[0]:
        return info, None, 0, 0, 0, 0
    # crop to the explored area
    x0, z0, x1, z1 = used
    cw, chh = x1 - x0 + 1, z1 - z0 + 1
    out = bytearray(cw * chh * 3)
    for z in range(chh):
        s = ((z0 + z) * W + x0) * 3
        out[z * cw * 3:(z + 1) * cw * 3] = pix[s:s + cw * 3]
    return info, out, cw, chh, minx + x0, minz + z0


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
    if "--png" in opt:
        info, pix, W, H, ox, oz = render(world, int(opt.get("--radius", "1024")))
        if pix is not None:
            png(opt["--png"], pix, W, H)
            info["map"] = {"x": ox, "z": oz, "width": W, "height": H}
        else:
            info["map"] = None
    else:
        info = level_info(world)
    info["modified"] = int(os.path.getmtime(os.path.join(world, "level.dat")))
    txt = json.dumps(info)
    if "--json" in opt:
        tmp = opt["--json"] + ".tmp"
        with open(tmp, "w") as f:
            f.write(txt)
        os.replace(tmp, opt["--json"])
    else:
        print(txt)


if __name__ == "__main__":
    main()
