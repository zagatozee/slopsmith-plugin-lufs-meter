"""
LUFS Meter plugin — routes.py

Provides:
  GET  /api/plugins/lufs-meter/song_volume?filename=...
       For PSARCs: reads SongVolume from the manifest JSON files in the
       extracted tmp dir (already on disk from the highway WS handler).
       Falls back to scanning the PSARC directly if the tmp dir is gone.
       Returns { volume_db, source, format }

  POST /api/plugins/lufs-meter/set_offset
       Persist a manual playback-volume offset for any song.
       Body: { filename, offset_db }

  GET  /api/plugins/lufs-meter/get_offset?filename=...
       Return the persisted offset for a song, or 0.0.

  GET  /api/plugins/lufs-meter/status
       Returns { version }
"""

import json
import os
import sqlite3
import threading
from pathlib import Path

from fastapi.responses import JSONResponse
from pydantic import BaseModel


def setup(app, context):
    config_dir: Path = context["config_dir"]
    get_dlc_dir = context["get_dlc_dir"]
    log = context["log"]

    db_path = config_dir / "lufs_meter.db"
    db_lock = threading.Lock()

    def _init_db():
        with db_lock:
            conn = sqlite3.connect(db_path)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS offsets (
                    filename TEXT PRIMARY KEY,
                    offset_db REAL NOT NULL
                )
            """)
            conn.commit()
            conn.close()

    _init_db()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _read_volume_from_manifest_dir(manifest_dir: Path) -> float | None:
        """
        Walk *.json files in an extracted PSARC directory and return the
        SongVolume value from the first non-vocals arrangement manifest.
        Returns None if not found.
        """
        for jf in sorted(manifest_dir.rglob("*.json")):
            try:
                jdata = json.loads(jf.read_text(encoding="utf-8"))
            except Exception:
                continue
            entries = jdata.get("Entries") if isinstance(jdata, dict) else None
            if not isinstance(entries, dict):
                continue
            for entry in entries.values():
                if not isinstance(entry, dict):
                    continue
                attrs = entry.get("Attributes")
                if not isinstance(attrs, dict):
                    continue
                arr_name = attrs.get("ArrangementName", "")
                if arr_name in ("Vocals", "ShowLights", "JVocals"):
                    continue
                vol = attrs.get("SongVolume")
                if vol is not None:
                    try:
                        return float(vol)
                    except (TypeError, ValueError):
                        pass
        return None

    def _read_volume_from_psarc(psarc_path: Path) -> float | None:
        """
        Read SongVolume directly from PSARC manifest JSON entries without
        fully extracting the archive to disk.
        """
        try:
            from psarc import read_psarc_entries
            entries = read_psarc_entries(str(psarc_path), ["*.json"])
            for path, data in entries.items():
                if not path.lower().endswith(".json"):
                    continue
                try:
                    jdata = json.loads(data)
                except Exception:
                    continue
                manifest_entries = jdata.get("Entries") if isinstance(jdata, dict) else None
                if not isinstance(manifest_entries, dict):
                    continue
                for entry in manifest_entries.values():
                    if not isinstance(entry, dict):
                        continue
                    attrs = entry.get("Attributes")
                    if not isinstance(attrs, dict):
                        continue
                    arr_name = attrs.get("ArrangementName", "")
                    if arr_name in ("Vocals", "ShowLights", "JVocals"):
                        continue
                    vol = attrs.get("SongVolume")
                    if vol is not None:
                        try:
                            return float(vol)
                        except (TypeError, ValueError):
                            pass
        except Exception as e:
            log.warning("PSARC manifest read failed for %s: %s", psarc_path, e)
        return None

    # ------------------------------------------------------------------
    # API endpoints
    # ------------------------------------------------------------------

    @app.get("/api/plugins/lufs-meter/song_volume")
    def song_volume(filename: str):
        """
        Return the SongVolume dB offset from the PSARC manifest.
        For sloppak/loose songs this is always 0.0 (no manifest offset).
        """
        dlc_dir = get_dlc_dir()
        if not dlc_dir:
            return JSONResponse({"volume_db": 0.0, "source": "no_dlc", "format": "unknown"})

        dlc_path = Path(dlc_dir)

        # Resolve the song path
        candidate = Path(filename)
        if not candidate.is_absolute():
            candidate = dlc_path / filename
        if not candidate.exists():
            # Try searching dlc dir
            matches = list(dlc_path.rglob(Path(filename).name))
            candidate = matches[0] if matches else None

        if candidate is None or not candidate.exists():
            return JSONResponse({"volume_db": 0.0, "source": "not_found", "format": "unknown"})

        suffix = candidate.suffix.lower() if candidate.is_file() else ""

        # Sloppak / loose — no manifest volume offset
        if suffix == ".sloppak" or (candidate.is_dir() and (candidate / "manifest.yaml").exists()):
            return JSONResponse({"volume_db": 0.0, "source": "none", "format": "sloppak"})
        if candidate.is_dir():
            return JSONResponse({"volume_db": 0.0, "source": "none", "format": "loose"})

        # PSARC — try the in-memory server extract cache first (tmp dir on disk),
        # then fall back to reading the PSARC directly.
        #
        # The server's _extract_cache is a module-level dict in server.py.
        # We can't import it directly, but the extracted tmp dirs follow a
        # predictable naming pattern: tempfile.mkdtemp(prefix="rs_web_").
        # Walk /tmp for a live extraction of this filename, or just go straight
        # to the PSARC.
        volume_db = None
        source = "psarc_direct"

        # Try live tmp dirs first (fastest, avoids re-reading the PSARC)
        tmp_root = Path("/tmp")
        for d in sorted(tmp_root.glob("rs_web_*"), key=lambda p: p.stat().st_mtime, reverse=True):
            if d.is_dir():
                vol = _read_volume_from_manifest_dir(d)
                if vol is not None:
                    # Verify this tmp dir actually belongs to our song by checking
                    # the stem name appears somewhere in the manifest JSON filenames
                    stem = Path(filename).stem.lower().replace(" ", "_")[:20]
                    json_names = " ".join(p.name.lower() for p in d.rglob("*.json"))
                    if stem[:8] in json_names or not json_names:
                        volume_db = vol
                        source = "extracted_cache"
                        break

        # Direct PSARC read (authoritative fallback)
        if volume_db is None:
            volume_db = _read_volume_from_psarc(candidate)
            source = "psarc_direct" if volume_db is not None else "not_found"

        if volume_db is None:
            volume_db = 0.0
            source = "not_found"

        log.debug("SongVolume for %s: %.2f dB (%s)", filename, volume_db, source)
        return JSONResponse({
            "volume_db": volume_db,
            "source": source,
            "format": "psarc"
        })

    class OffsetBody(BaseModel):
        filename: str
        offset_db: float

    @app.post("/api/plugins/lufs-meter/set_offset")
    def set_offset(body: OffsetBody):
        offset = max(-30.0, min(30.0, body.offset_db))
        with db_lock:
            conn = sqlite3.connect(db_path)
            conn.execute(
                "INSERT OR REPLACE INTO offsets (filename, offset_db) VALUES (?, ?)",
                (body.filename, offset)
            )
            conn.commit()
            conn.close()
        log.info("Stored volume offset %.1f dB for %s", offset, body.filename)
        return {"ok": True}

    @app.get("/api/plugins/lufs-meter/get_offset")
    def get_offset(filename: str):
        with db_lock:
            conn = sqlite3.connect(db_path)
            row = conn.execute(
                "SELECT offset_db FROM offsets WHERE filename = ?", (filename,)
            ).fetchone()
            conn.close()
        return {"offset_db": row[0] if row else 0.0}

    @app.get("/api/plugins/lufs-meter/status")
    def status():
        return {"version": "1.5.5"}

    log.info("LUFS Meter plugin ready")
