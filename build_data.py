#!/usr/bin/env python3
"""
Build roads.json + roaddata.bin from the original single-file SLKAPP HTML
(the one with `const roads = [...]` and `const roadData = [...]` inline).

Run this whenever the source HTML's road/point data changes, to regenerate
the two data files the split app (index.html + app.js) fetches at runtime.

Usage:
    python3 build_data.py SLKAPP_B17.html [output_dir]
"""
import sys
import re
import json
import struct
from pathlib import Path

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    src_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(".")
    out_dir.mkdir(parents=True, exist_ok=True)

    text = src_path.read_text(encoding="utf-8")

    # ---- Extract roads = [ { id:"...", name:"..." }, ... ] ----
    roads_match = re.search(r"const\s+roads\s*=\s*\[(.*?)\n\s*\];", text, re.S)
    if not roads_match:
        sys.exit("Could not find `const roads = [ ... ];` block in source HTML")
    roads_body = roads_match.group(1)
    road_entry_re = re.compile(r'\{\s*id\s*:\s*"([^"]+)"\s*,\s*name\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}')
    roads = []
    for m in road_entry_re.finditer(roads_body):
        rid, name = m.group(1), m.group(2)
        name = name.replace('\\"', '"')
        roads.append({"id": rid, "name": name})
    if not roads:
        sys.exit("Parsed 0 roads — regex may not match this file's formatting")

    # ---- Extract roadData = [ [code, slk, lon, lat], ... ] ----
    data_match = re.search(r"const\s+roadData\s*=\s*\[(.*?)\n\s*\];", text, re.S)
    if not data_match:
        sys.exit("Could not find `const roadData = [ ... ];` block in source HTML")
    data_body = data_match.group(1)
    point_re = re.compile(r"\[\s*(-?\d+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]")

    codes, slks, lons, lats = [], [], [], []
    for m in point_re.finditer(data_body):
        code, slk, lon, lat = m.groups()
        codes.append(int(code))
        slks.append(float(slk))
        lons.append(float(lon))
        lats.append(float(lat))

    n = len(codes)
    if n == 0:
        sys.exit("Parsed 0 road-data points — regex may not match this file's formatting")

    # ---- Sanity checks before we commit to the compact encoding ----
    if max(codes) > 65535 or min(codes) < 0:
        sys.exit(f"roadCode {min(codes)}..{max(codes)} does not fit in Uint16 — "
                  f"widen the format (see comment in app.js) before proceeding")

    slk_centi = [round(s * 100) for s in slks]
    # Confirm rounding to centi-km (10m) didn't silently eat real precision.
    worst = max(abs(sc / 100 - s) for sc, s in zip(slk_centi, slks))
    if worst > 0.005:
        sys.exit(f"SLK values need finer than 0.01 precision (worst-case drift "
                  f"{worst:.4f} km) — widen the format before proceeding")
    if max(slk_centi) > 65535 or min(slk_centi) < 0:
        sys.exit(f"SLK*100 range {min(slk_centi)}..{max(slk_centi)} does not fit "
                  f"in Uint16 — widen the format before proceeding")

    # ---- Write roads.json ----
    roads_path = out_dir / "roads.json"
    roads_path.write_text(json.dumps(roads, separators=(",", ":")), encoding="utf-8")

    # ---- Write roaddata.bin ----
    # Layout (little-endian), all sections at aligned offsets so the JS side
    # can wrap each with a typed array view directly on the fetched buffer:
    #   [0:4]              Uint32   N  (point count)
    #   [4 : 4+2N]         Uint16[N]  roadCode
    #   [4+2N : 4+4N]      Uint16[N]  slk in centi-km (slk_km * 100, rounded)
    #   [4+4N : 4+8N]      Float32[N] longitude (degrees)
    #   [4+8N : 4+12N]     Float32[N] latitude (degrees)
    bin_path = out_dir / "roaddata.bin"
    with open(bin_path, "wb") as f:
        f.write(struct.pack("<I", n))
        f.write(struct.pack(f"<{n}H", *codes))
        f.write(struct.pack(f"<{n}H", *slk_centi))
        f.write(struct.pack(f"<{n}f", *lons))
        f.write(struct.pack(f"<{n}f", *lats))

    print(f"roads.json      : {len(roads)} roads, {roads_path.stat().st_size:,} bytes")
    print(f"roaddata.bin    : {n:,} points, {bin_path.stat().st_size:,} bytes "
          f"(was ~{(data_match.end()-data_match.start()):,} bytes of inline JS source)")

if __name__ == "__main__":
    main()
