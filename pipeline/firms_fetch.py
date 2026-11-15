"""NASA VIIRS 375 m active fires (the data behind FIRMS) over the study tiles, Sep 20 – Nov 30 2026.

Products: VNP14IMG (Suomi-NPP), VJ114IMG (NOAA-20), VJ214IMG (NOAA-21), collection 002, LP DAAC.
Only the fire-pixel arrays are read remotely (earthaccess + h5py, Earthdata netrc login).
Keeps detections inside the tile boxes (+0.02 deg) with confidence nominal/high (FP_confidence >= 8,
i.e. classes 8 nominal and 9 high; 7 = low is dropped).
Output: artifacts/firms_fires.jsonl {lat, lon, date, time, sat, confidence, frp_mw, granule}
"""
import json, os, re, sys
import h5py, numpy as np, earthaccess

BOXES = {"fazilka": (73.95, 30.33, 74.11, 30.47), "muktsar": (74.44, 30.40, 74.60, 30.54),
         "bathinda": (74.82, 30.24, 74.98, 30.38)}
PAD = 0.02


def main():
    earthaccess.login(strategy="netrc")
    out_path = os.path.join("artifacts", "firms_fires.jsonl")
    done = set()
    if os.path.exists(out_path):
        done = {json.loads(l)["granule"] for l in open(out_path) if '"granule"' in l}
    log = open(out_path, "a")
    res = []
    for sn in ("VNP14IMG", "VJ114IMG", "VJ214IMG"):
        res += earthaccess.search_data(short_name=sn, bounding_box=(73.9, 30.2, 75.0, 30.6), temporal=("2026-09-20", "2026-11-30"))
    todo = [g for g in res if g["meta"]["native-id"] not in done]
    print(len(res), "granules,", len(todo), "to read", flush=True)
    for k in range(0, len(todo), 20):
        batch = todo[k:k + 20]
        files = earthaccess.open(batch)
        for g, f in zip(batch, files):
            gid = g["meta"]["native-id"]
            try:
                with h5py.File(f, "r") as h:
                    if "FP_latitude" not in h or h["FP_latitude"].shape[0] == 0:
                        log.write(json.dumps({"granule": gid, "n": 0}) + chr(10)); continue
                    la, lo = h["FP_latitude"][:], h["FP_longitude"][:]
                    cf, frp = h["FP_confidence"][:], h["FP_power"][:]
                m = np.zeros(len(la), bool)
                for b in BOXES.values():
                    m |= (lo >= b[0] - PAD) & (lo <= b[2] + PAD) & (la >= b[1] - PAD) & (la <= b[3] + PAD)
                m &= cf >= 8
                dt_ = re.search(r"\.A(\d{7})\.(\d{4})\.", gid)
                import datetime as dt
                day = dt.datetime.strptime(dt_.group(1), "%Y%j").date()
                for i in np.nonzero(m)[0]:
                    log.write(json.dumps({"lat": round(float(la[i]), 5), "lon": round(float(lo[i]), 5), "date": str(day),
                                          "time": dt_.group(2), "sat": gid[:3], "confidence": int(cf[i]),
                                          "frp_mw": round(float(frp[i]), 2), "granule": gid}) + chr(10))
                log.write(json.dumps({"granule": gid, "n": int(m.sum())}) + chr(10))
            except Exception as e:
                print("skip", gid, str(e)[:100], flush=True)
        log.flush()
        print(f"{min(k + 20, len(todo))}/{len(todo)}", flush=True)
    log.close()


if __name__ == "__main__":
    main()
