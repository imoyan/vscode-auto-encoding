"""Read-only VSIX privacy guard. Never print matched values or archive paths."""
import json
import re
import sys
import unicodedata
import zipfile
from collections import Counter

MAX_ENTRY = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
# A home directory can end at a closing JSON/JS delimiter, with no trailing slash.
UNIX_PATH_END = r"""(?=[/\x00\r\n"'`]|$)"""
PATTERNS = {
    "mac_home_path": re.compile(r"(?<![A-Za-z0-9_])/Users/[\w.@ -]+" + UNIX_PATH_END),
    "linux_home_path": re.compile(r"(?<![A-Za-z0-9_])/home/[\w.@-]+" + UNIX_PATH_END),
    "windows_home_path": re.compile(r"(?i)(?<![A-Za-z0-9_])[A-Z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\x00\r\n\"<>:]+"),
    # Only an explicit DNS label with .local/.lan, not arbitrary human names.
    "private_hostname": re.compile(r"(?i)(?<![A-Za-z0-9_.-])[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.(?:local|lan)(?![A-Za-z0-9_.-])"),
}

def samples(filename, content):
    yield filename
    yield content.decode("utf-8", errors="replace")
    for encoding in ("utf-16-le", "utf-16-be"):
        for offset in (0, 1):
            yield content[offset:].decode(encoding, errors="replace")


def scan(path):
    counts = Counter()
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if sum(e.file_size for e in entries) > MAX_TOTAL:
            return {"archive_size_limit": 1}
        for entry in entries:
            if entry.is_dir():
                continue
            if entry.file_size > MAX_ENTRY:
                counts["entry_size_limit"] += 1
                continue
            if entry.filename.lower().endswith(".map"):
                counts["source_map"] += 1
            content = archive.read(entry)
            # Scan names, UTF-8 payloads and both byte alignments of native
            # UTF-16 strings. Count each category at most once per entry.
            remaining = PATTERNS.copy()
            for sample in samples(entry.filename, content):
                sample = unicodedata.normalize("NFC", sample)
                for category in tuple(remaining):
                    if remaining[category].search(sample):
                        counts[category] += 1
                        del remaining[category]
                if not remaining:
                    break
    return dict(sorted(counts.items()))

def main():
    if len(sys.argv) != 2:
        print('{"error":"one_vsix_required"}')
        return 2
    try:
        findings = scan(sys.argv[1])
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, NotImplementedError):
        print('{"error":"archive_unreadable"}')
        return 2
    print(json.dumps({"passed": not findings, "categories": findings}, sort_keys=True))
    return 1 if findings else 0

if __name__ == "__main__":
    raise SystemExit(main())
