# API Audit — Corrections from Real Documentation

## CRITICAL WRONG ASSUMPTIONS (must fix)

### 1. BASE URL — WRONG
- **I assumed:** `https://juicewrldapi.com/api/`
- **Reality:** `https://juicewrldapi.com/juicewrld/`
- **Impact:** Every single API call path was wrong

### 2. AUDIO STREAMING — COMPLETELY WRONG
- **I assumed:** There's a `/api/player/play/{songId}` endpoint returning a stream URL
- **Reality:** Streaming is via `GET /files/download/?path={file_path}` with the song's `path` field
- **The song model itself contains a `path` field** that maps directly to the file for streaming
- **Range requests** go directly to `/files/download/` with `Range` HTTP header
- **No intermediate "stream URL" is generated** — you stream the file directly
- **Impact:** My entire audio proxy service, stream URL caching, and expiry logic were built on a fiction

### 3. SONG MODEL — MASSIVELY INCOMPLETE
- **I had:** id, name, category, era, track_titles, credited_artists, producers, engineers, length
- **Reality — full model:**
  - `id` (internal DB id, integer)
  - `public_id` (public-facing integer id)
  - `name` (song title)
  - `original_key` (original JSON key)
  - `category` (released|unreleased|unsurfaced|recording_session)
  - `path` — **CRITICAL: the streaming file path**
  - `era` (nested: {id, name, description, time_frame, play_count})
  - `track_titles` (string array — these ARE the aliases)
  - `credited_artists` (string)
  - `producers` (string)
  - `engineers` (string)
  - `recording_locations` (string)
  - `record_dates` (string)
  - `length` (string like "3:59", NOT integer ms)
  - `bitrate` (string)
  - `additional_information` (string)
  - `file_names` (string, or array if `file_names_array=true`)
  - `instrumentals` (string)
  - `preview_date` (string)
  - `release_date` (string)
  - `dates` (string)
  - `session_titles` (string)
  - `session_tracking` (string)
  - `instrumental_names` (string)
  - `notes` (string — combined JSON notes blob)
  - `lyrics` — **THE API ALREADY HAS LYRICS TEXT**
  - `snippets` (array)
  - `date_leaked` (string)
  - `leak_type` (string)
  - `image_url` (string — era-based image)

### 4. LYRICS — API ALREADY HAS THEM
- **I assumed:** The API has no lyrics; we build lyrics from scratch
- **Reality:** The song model has a `lyrics` field with raw text lyrics
- **AND** there's a `lyrics` search parameter: `GET /songs/?lyrics=lucid dreams`
- **Impact:** We can IMPORT existing lyrics as base text, then our system adds timing/sync on top

### 5. PAGINATION FORMAT — WRONG
- **I assumed:** Standard page/pageSize response
- **Reality:** Django REST Framework style:
  ```json
  {
    "count": 1234,
    "next": "https://juicewrldapi.com/juicewrld/songs/?page=2",
    "previous": null,
    "results": [...]
  }
  ```

### 6. SEARCH — RICHER THAN ASSUMED
- **I assumed:** Basic text search
- **Reality:** Three distinct search modes:
  - `search` — searches song names, credited artists, track titles (normalizes special chars)
  - `searchall` — also includes producers
  - `lyrics` — searches within lyric content
  - Special char normalization: "dont" matches "don't"

### 7. ERA MODEL — MORE DATA
- **I assumed:** {id, name, description, time_frame}
- **Reality:** Also includes `play_count` (integer)

### 8. AUTHENTICATION — NONE REQUIRED
- **I assumed:** Possible API key or auth
- **Reality:** No authentication mentioned anywhere. API is open.

### 9. COVER ART — AVAILABLE
- **I assumed:** No cover art
- **Reality:** `GET /files/cover-art/?path={audio_file_path}` extracts embedded cover art

### 10. FILE BROWSER — FULL DIRECTORY BROWSING
- `GET /files/browse/?path=Compilation` — list files and folders
- `GET /files/browse/?path=Compilation&search=.mp3` — filter by name/extension
- `GET /files/info/?path=...` — file metadata
- This means we can browse the ENTIRE file tree, not just API-indexed songs

### 11. RADIO ENDPOINT — EXISTS
- `GET /radio/random/` — returns a random playable song with FULL metadata
- Response includes both file info AND matched song DB entry
- Useful for "discover" / shuffle features

### 12. SHARED PLAYLISTS — API SUPPORTS THEM
- `POST /playlists/share/` — create shareable playlist
- `GET /playlists/shared/{share_id}/` — fetch by ID
- `GET /playlists/shared/{share_id}/info/` — preview metadata

### 13. ZIP JOBS — BACKGROUND PROCESSING
- `POST /start-zip-job/` with `{ "paths": [...] }`
- `GET /zip-job-status/{job_id}/` — poll progress
- `POST /cancel-zip-job/{job_id}/` — cancel
- `POST /files/zip-selection/` — immediate ZIP stream

## WHAT WAS CORRECT
- Categories: released, unreleased, unsurfaced, recording_session
- Track_titles serve as aliases
- Era filtering works
- The API is community-maintained and could go down
- Need a proxy layer between our frontend and this API
- Need to cache metadata locally

## ARCHITECTURAL CHANGES REQUIRED

1. **Rewrite `juice-api.ts` service** — correct base URL, correct endpoints, correct response shapes
2. **Rewrite audio proxy** — stream from `/files/download/?path=` using song's `path` field, not a "stream URL"
3. **Update Prisma schema** — add all missing song fields, especially `path`, `public_id`, `lyrics`, `image_url`, etc.
4. **Add lyrics import** — when syncing catalog, grab the `lyrics` text field as raw lyrics for timing
5. **Add cover art proxy** — `/files/cover-art/?path=`
6. **Add radio endpoint** — proxy `/radio/random/`
7. **Add file browser** — optionally expose the file tree for admin use
8. **Update song routes** — correct response shapes
