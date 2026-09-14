#!/usr/bin/env python3

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


API_URL = "https://ws.audioscrobbler.com/2.0/"
OUTPUT_FILE = Path("lastfm_data.json")

# January 1, 2000 00:00:00 UTC
INITIAL_FROM = 946684800

# Last.fm officially supports a maximum of 200 results per page.
PAGE_SIZE = 200

# Retry settings for temporary Last.fm failures.
MAX_RETRIES = 5
RETRY_DELAY = 5


def get_environment():
    username = os.environ.get("LASTFM_USERNAME")
    api_key = os.environ.get("LASTFM_API_KEY")

    if not username:
        raise RuntimeError("LASTFM_USERNAME is not set")

    if not api_key:
        raise RuntimeError("LASTFM_API_KEY is not set")

    return username, api_key


def api_request(api_key, params):
    params = {
        "api_key": api_key,
        "format": "json",
        **params,
    }

    url = API_URL + "?" + urllib.parse.urlencode(params)

    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Music-Library-Statistics/1.0"
                },
            )

            with urllib.request.urlopen(request, timeout=60) as response:
                data = json.loads(response.read().decode("utf-8"))

            # Last.fm sometimes returns HTTP 200 with an API error.
            if "error" in data:
                error_code = data.get("error")
                error_message = data.get("message", "Unknown Last.fm error")

                # Error 29 = rate limit exceeded.
                if str(error_code) == "29":
                    raise RuntimeError(
                        f"Last.fm rate limit exceeded: {error_message}"
                    )

                raise RuntimeError(
                    f"Last.fm API error {error_code}: {error_message}"
                )

            return data

        except Exception as error:
            last_error = error

            if attempt < MAX_RETRIES:
                delay = RETRY_DELAY * attempt
                print(
                    f"Request failed (attempt {attempt}/{MAX_RETRIES}): "
                    f"{error}"
                )
                print(f"Retrying in {delay} seconds...")
                time.sleep(delay)
            else:
                break

    raise RuntimeError(
        f"Last.fm request failed after {MAX_RETRIES} attempts: {last_error}"
    )


def load_existing(username):
    if not OUTPUT_FILE.exists():
        print("No existing lastfm_data.json found.")
        print("Performing a full history import.")
        return {
            "username": username,
            "scrobbles": [],
        }

    try:
        with OUTPUT_FILE.open("r", encoding="utf-8") as file:
            data = json.load(file)
    except Exception as error:
        raise RuntimeError(
            f"Could not read {OUTPUT_FILE}: {error}"
        )

    if not isinstance(data, dict):
        raise RuntimeError("lastfm_data.json does not contain an object.")

    if "scrobbles" not in data:
        raise RuntimeError(
            "lastfm_data.json does not contain a 'scrobbles' array."
        )

    # Always use the configured username.
    data["username"] = username

    return data


def get_start_timestamp(scrobbles):
    if not scrobbles:
        return INITIAL_FROM

    timestamps = [
        int(scrobble["date"]) // 1000
        for scrobble in scrobbles
        if "date" in scrobble
    ]

    if not timestamps:
        return INITIAL_FROM

    newest = max(timestamps)

    # Fetch a one-second overlap. This protects against multiple scrobbles
    # having the same timestamp. Duplicates are removed later.
    return max(0, newest - 1)


def make_scrobble(track):
    # Last.fm includes a currently-playing track without a timestamp.
    if "date" not in track:
        return None

    if track.get("@attr", {}).get("nowplaying") == "true":
        return None

    artist = track.get("artist", {})
    album = track.get("album", {})

    artist_name = artist.get("#text", "")
    album_name = album.get("#text", "")
    album_id = album.get("mbid", "") or ""

    timestamp = track["date"].get("uts")

    if timestamp is None:
        return None

    return {
        "track": track.get("name", ""),
        "artist": artist_name,
        "album": album_name,
        "albumId": album_id,
        "date": int(timestamp) * 1000,
    }


def scrobble_key(scrobble):
    """
    Identifies a listening event.

    The timestamp is the most important component, but including the other
    fields makes accidental collisions extremely unlikely.
    """
    return (
        scrobble.get("date"),
        scrobble.get("artist", ""),
        scrobble.get("track", ""),
        scrobble.get("album", ""),
    )


def fetch_history(username, api_key, from_timestamp):
    now = int(time.time())

    print(
        f"Fetching scrobbles from "
        f"{time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(from_timestamp))}"
    )

    # First request determines the total number of pages.
    first = api_request(
        api_key,
        {
            "method": "user.getRecentTracks",
            "user": username,
            "from": from_timestamp,
            "to": now,
            "limit": PAGE_SIZE,
            "page": 1,
        },
    )

    recent_tracks = first.get("recenttracks", {})
    attributes = recent_tracks.get("@attr", {})

    total_pages = int(attributes.get("totalPages", 0))
    total_tracks = int(attributes.get("total", 0))

    print(f"Last.fm reports {total_tracks:,} matching scrobbles.")
    print(f"Pages to retrieve: {total_pages:,}")

    if total_pages == 0:
        return []

    all_scrobbles = []

    for page in range(1, total_pages + 1):
        if page == 1:
            data = first
        else:
            data = api_request(
                api_key,
                {
                    "method": "user.getRecentTracks",
                    "user": username,
                    "from": from_timestamp,
                    "to": now,
                    "limit": PAGE_SIZE,
                    "page": page,
                },
            )

        tracks = data.get("recenttracks", {}).get("track", [])

        # Last.fm can return an object instead of an array when only one
        # track is present.
        if isinstance(tracks, dict):
            tracks = [tracks]

        page_scrobbles = []

        for track in tracks:
            scrobble = make_scrobble(track)

            if scrobble is not None:
                page_scrobbles.append(scrobble)

        all_scrobbles.extend(page_scrobbles)

        print(
            f"Page {page:,}/{total_pages:,}: "
            f"{len(page_scrobbles):,} scrobbles"
        )

    return all_scrobbles


def merge_scrobbles(existing, new):
    combined = existing + new

    # Deduplicate while preserving the first occurrence.
    unique = {}

    for scrobble in combined:
        key = scrobble_key(scrobble)

        if key not in unique:
            unique[key] = scrobble

    # The existing website/data format expects chronological ordering.
    result = list(unique.values())
    result.sort(key=lambda x: x["date"])

    return result


def save_data(username, scrobbles):
    output = {
        "username": username,
        "scrobbles": scrobbles,
    }

    # Compact JSON, matching the general format of your existing file.
    serialized = json.dumps(
        output,
        ensure_ascii=False,
        separators=(",", ":"),
    )

    # Add a final newline for normal Git usage.
    serialized += "\n"

    existing_content = None

    if OUTPUT_FILE.exists():
        existing_content = OUTPUT_FILE.read_text(encoding="utf-8")

    if existing_content == serialized:
        print("No changes to lastfm_data.json.")
        return False

    OUTPUT_FILE.write_text(serialized, encoding="utf-8")

    print(
        f"Wrote {len(scrobbles):,} total scrobbles to "
        f"{OUTPUT_FILE}"
    )

    return True


def main():
    username, api_key = get_environment()

    existing_data = load_existing(username)
    existing_scrobbles = existing_data["scrobbles"]

    print(f"Existing scrobbles: {len(existing_scrobbles):,}")

    from_timestamp = get_start_timestamp(existing_scrobbles)

    new_scrobbles = fetch_history(
        username,
        api_key,
        from_timestamp,
    )

    print(f"Downloaded: {len(new_scrobbles):,}")

    merged = merge_scrobbles(
        existing_scrobbles,
        new_scrobbles,
    )

    print(f"After deduplication: {len(merged):,}")

    changed = save_data(username, merged)

    if changed:
        print("lastfm_data.json was updated.")
    else:
        print("lastfm_data.json was already up to date.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
