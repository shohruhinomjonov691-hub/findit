"""Download the feasibility test set from Wikimedia Commons and write its manifest.

Images are not committed (data/testset/ is git-ignored); the manifest records
source page, author, license and SHA-256 of each downloaded file so the set can
be re-fetched and checked.

    python scripts/fetch_testset.py
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.parse
from pathlib import Path

import certifi
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "testset"
MANIFEST = ROOT / "data" / "testset_manifest.json"
API = "https://commons.wikimedia.org/w/api.php"
HEADERS = {"User-Agent": "FindIt-feasibility/0.1 (local research; https://commons.wikimedia.org)"}
THUMB_WIDTH = 1600  # Commons renders a scaled copy; originals are 1–35 MP.

# (local id, Commons file title, scenario note)
SELECTION = [
    ("01_desk_laptop_mouse_phone", "Computer mouse laptop and phone on a desk.jpg", "multiple objects, desk"),
    ("02_desk_setup", "Desk setup.jpg", "multiple objects, desk"),
    ("03_gadgets_desk", "Gadgets on a desk (Unsplash).jpg", "top view, many gadgets"),
    ("04_half_closed_laptop", "Half-closed laptop (Unsplash).jpg", "partly closed / occluded laptop"),
    ("05_desktop_after_work", "Desktop after work (Unsplash).jpg", "multiple objects, mixed light"),
    ("06_coffee_mug", "Coffee mug on table.jpg", "single cup"),
    ("07_mug_wooden_table", "Mug of Coffee on a Wooden Table (26804116318).jpg", "single cup"),
    ("08_coffee_sets", "02021 0274 (2) Coffee sets.jpg", "several similar cups"),
    ("09_iphone_desk", "Apple-iphone-smartphone-desk (24243796611).jpg", "phone on desk"),
    ("10_two_smartphones", "Top view image of two smartphone on a wooden table, space for text, ready for mockup. Empty space. (47955056488).jpg", "two similar phones"),
    ("11_metal_bottles", "Metal Water Bottles.jpeg", "several similar bottles"),
    ("12_fridge_bottles", "Bottles of water and a tray of ice cubes inside a fridge freezer.jpg", "bottles, cluttered / occluded"),
    ("13_round_table_books", "Round Table Books.jpg", "many books"),
    ("14_books_measuring_tape", "Measuring tape next to a stack of books on a wooden table. (51145551839).jpg", "stacked books"),
    ("15_reading_mail_night", "Reading mail at night (Unsplash).jpg", "low light"),
    ("16_dark_room_mac", "Woman in a dark room looking to a mac computer.jpg", "low light, laptop"),
    ("17_mountain_lake", "Zagedan Lakes, Mountain cirque, Caucasus Mountains.jpg", "no target objects"),
    ("18_empty_coffee_shop", "Empty coffee shop interior with wooden table and water skis.jpg", "indoor, target objects likely absent"),
    ("19_wireless_mouse", "A wireless computer mouse.jpg", "single mouse"),
    ("20_old_book_coffee", "Old book and coffee on a wooden table in the kitchen.jpg", "book + cup"),
]


def strip_html(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", value)).strip()


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update(HEADERS)
    session.verify = certifi.where()

    titles = ["File:" + t for _, t, _ in SELECTION]
    resp = session.get(API, params={
        "action": "query", "format": "json", "titles": "|".join(titles),
        "prop": "imageinfo", "iiprop": "url|size|sha1|extmetadata", "iiurlwidth": THUMB_WIDTH,
        "iiextmetadatafilter": "LicenseShortName|LicenseUrl|Artist|Credit|UsageTerms",
    }, timeout=30)
    resp.raise_for_status()
    data = resp.json()["query"]
    normalized = {n["from"]: n["to"] for n in data.get("normalized", [])}
    pages = {p["title"]: p for p in data["pages"].values()}

    entries = []
    for local_id, title, note in SELECTION:
        page = pages[normalized.get("File:" + title, "File:" + title)]
        if "imageinfo" not in page:
            print(f"MISSING {title}")
            continue
        info = page["imageinfo"][0]
        meta = {k: strip_html(v["value"]) for k, v in info.get("extmetadata", {}).items()}
        url = info.get("thumburl") or info["url"]
        ext = Path(urllib.parse.urlparse(url).path).suffix.lower() or ".jpg"
        dest = OUT_DIR / f"{local_id}{ext}"
        if not dest.exists():
            img = session.get(url, timeout=60)
            img.raise_for_status()
            dest.write_bytes(img.content)
            time.sleep(1.0)
        entries.append({
            "id": local_id,
            "file": dest.name,
            "scenario": note,
            "commons_title": page["title"],
            "source_page": info["descriptionurl"],
            "download_url": url,
            "original_size": [info["width"], info["height"]],
            "author": meta.get("Artist", ""),
            "credit": meta.get("Credit", ""),
            "license": meta.get("LicenseShortName", ""),
            "license_url": meta.get("LicenseUrl", ""),
            "modified": f"scaled by Wikimedia to {THUMB_WIDTH}px width" if info.get("thumburl") else "none",
            "sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
        })
        print(f"{local_id:<28} {meta.get('LicenseShortName', '?'):<14} {dest.name}")

    MANIFEST.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(entries)} images -> {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
