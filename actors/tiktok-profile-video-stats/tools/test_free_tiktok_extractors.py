#!/usr/bin/env python3
"""Compare free, open-source TikTok profile extractors. No video downloads or paid APIs.

Install locally:
  python -m pip install -U yt-dlp gallery-dl
Run:
  python tools/test_free_tiktok_extractors.py allanainaction
Outputs only diagnostic summaries and public video IDs/URLs. Never logs cookies.
"""
import json
import re
import shutil
import subprocess
import sys

HANDLE = (sys.argv[1] if len(sys.argv) > 1 else "allanainaction").strip().lstrip("@")
if not re.fullmatch(r"[A-Za-z0-9._]{1,40}", HANDLE):
    raise SystemExit("Invalid TikTok handle")
URL = f"https://www.tiktok.com/@{HANDLE}"
TIMEOUT = 90


def run(name, args):
    if not shutil.which(args[0]):
        print(json.dumps({"extractor": name, "status": "not_installed"}))
        return
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        print(json.dumps({"extractor": name, "status": "timeout"}))
        return
    ids = set()
    links = []
    for line in result.stdout.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            entries = item.get("entries")
            records = entries if isinstance(entries, list) else [item]
        elif isinstance(item, list):
            records = [part for part in item if isinstance(part, dict)]
        else:
            records = []
        for record in records:
            if not isinstance(record, dict):
                continue
            video_id = str(record.get("id") or record.get("aweme_id") or "")
            link = str(record.get("webpage_url") or record.get("url") or "")
            if not re.fullmatch(r"\d{15,25}", video_id):
                match = re.search(r"/video/(\d{15,25})", link)
                video_id = match.group(1) if match else ""
            if video_id and video_id not in ids:
                ids.add(video_id)
                links.append(f"https://www.tiktok.com/@{HANDLE}/video/{video_id}")
    # Only a short, sanitized error classification; stderr may contain sensitive data.
    stderr = result.stderr.lower()
    error_type = ("rate_limited" if "429" in stderr else
                  "access_denied" if "403" in stderr else
                  "user_id_unavailable" if "secondary user id" in stderr else
                  "other_error" if result.returncode else None)
    print(json.dumps({"extractor": name, "exit_code": result.returncode,
                      "error_type": error_type, "video_count": len(links),
                      "video_urls": links[:30]}, indent=2))


run("yt-dlp", ["yt-dlp", "--flat-playlist", "--dump-single-json",
               "--playlist-end", "30", "--skip-download", "--no-warnings", URL])
run("gallery-dl", ["gallery-dl", "--dump-json", "--range", "1-30", URL])
