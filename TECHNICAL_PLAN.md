# JuiceVault — Technical Plan
## Private Juice WRLD Lyrics-First Music Vault

**Author:** Claude (Senior Engineer)
**Date:** February 2026
**Status:** Phase 1 — Foundation

---

## 1. Executive Summary

JuiceVault is a private, invite-only web application for streaming Juice WRLD's complete discography (2,700+ tracks including unreleased material) with a focus on perfectly timed, line-by-line synchronized lyrics. Think Spotify-level playback meets Apple Music lyrics, purpose-built for one artist's entire vault.

---

## 2. External API Research — Juice WRLD API

### Findings
- **URL:** `https://juicewrldapi.com`
- **Official Python Wrapper:** `juicewrld-api-wrapper` (PyPI, v1.0.4)
- **Catalog Size:** 2,700+ songs across released, unreleased, recording sessions, unsurfaced
- **Audio Streaming:** Supports direct file streaming with range requests (HTTP 206)
- **Categories:** released, unreleased, recording_session, unsurfaced
- **Metadata:** Song name, era, track titles (aliases), producers, engineers, recording locations, dates, session tracking
- **Search:** Text search by title/artist, category filtering, era filtering
- **Rate Limits:**
  - Search: 100 req/min
  - Downloads: 50 req/min
  - Streaming: 30 req/min
  - ZIP: 10 req/min

### Key Endpoints (from wrapper analysis)
| Endpoint | Description |
|---|---|
| `get_songs(category, page, page_size)` | Paginated song listing |
| `get_song(id)` | Single song by ID |
| `search_songs(query, limit)` | Fuzzy text search |
| `get_songs_by_category(category)` | Category-filtered listing |
| `get_categories()` | Available categories |
| `get_eras()` | Musical eras (DRFL, GB&GR, etc.) |
| `get_stats()` | Total counts |
| `stream_audio_file(file_path)` | Direct audio stream URL |
| `play_juicewrld_song(song_id)` | Player stream URL |
| `browse_files()` | Directory structure browsing |
| `get_artists()` / `get_albums()` | Artist/album metadata |

### Risks & Mitigations
| Risk | Severity | Mitigation |
|---|---|---|
| API goes offline | HIGH | Cache song metadata in PostgreSQL; proxy audio through our backend |
| Stream URLs expire | MEDIUM | Backend proxy regenerates URLs on-demand; never expose raw URLs to client |
| Rate limiting | MEDIUM | Redis-backed request queue; respect limits; cache aggressively |
| Incomplete metadata | LOW | Allow admin manual entry; community can fill gaps |
| Audio files removed | MEDIUM | Health check job; admin broken-track dashboard |

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    FRONTEND                          │
│  Next.js 14 (App Router) + TypeScript + Tailwind    │
│  ┌─────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │ Player  │ │ Catalog  │ │   Lyric Sync Editor  │ │
│  │ + Queue │ │ + Search │ │   (Waveform + Tap)   │ │
│  └────┬────┘ └────┬─────┘ └──────────┬───────────┘ │
│       │           │                   │             │
│  Web Audio API    │            AudioContext          │
│  (time source)    │           (drift-corrected)     │
└───────┬───────────┼───────────────────┬─────────────┘
        │           │                   │
     ───┴───────────┴───────────────────┴───
        HTTPS / WebSocket
     ────────────────┬──────────────────────
                     │
┌────────────────────┴────────────────────────────────┐
│                    BACKEND                           │
│  Node.js + Express + TypeScript                     │
│  ┌─────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │  Auth   │ │  Audio   │ │   Lyrics Service     │ │
│  │  RBAC   │ │  Proxy   │ │   (CRUD + versions)  │ │
│  └────┬────┘ └────┬─────┘ └──────────┬───────────┘ │
│       │           │                   │             │
│  ┌────┴───────────┴───────────────────┴───────────┐ │
│  │              PostgreSQL + Redis                 │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │  Admin  │ │  Search  │ │  Health Check Jobs   │ │
│  │  Panel  │ │ Typesense│ │  (cron / background) │ │
│  └─────────┘ └──────────┘ └──────────────────────┘ │
└─────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────┐
│ Juice WRLD API   │
│ (external, proxy)│
└──────────────────┘
```

---

## 4. Database Schema

### Core Tables

**users**
- id (UUID, PK)
- email (unique)
- password_hash
- display_name
- role (enum: admin, trusted_contributor, user)
- invited_by (FK → users)
- invite_code (unique)
- reputation_score (int, default 0)
- created_at, updated_at
- is_active (boolean)

**songs**
- id (UUID, PK)
- external_id (int, from API)
- title (text)
- category (enum: released, unreleased, recording_session, unsurfaced)
- era_id (FK → eras)
- duration_ms (int, nullable)
- producers (text)
- engineers (text)
- recording_location (text)
- record_date (text)
- external_file_path (text) — path for API streaming
- stream_url_cached (text, nullable) — cached stream URL
- stream_url_expires_at (timestamp)
- is_available (boolean, default true)
- last_health_check (timestamp)
- play_count (int, default 0)
- created_at, updated_at

**song_aliases**
- id (UUID, PK)
- song_id (FK → songs)
- alias (text)
- is_primary (boolean)

**eras**
- id (UUID, PK)
- external_id (int)
- name (text) — e.g. "DRFL", "GB&GR"
- description (text)
- time_frame (text)
- sort_order (int)

**lyrics_versions**
- id (UUID, PK)
- song_id (FK → songs)
- author_id (FK → users)
- version_number (int)
- status (enum: draft, pending_review, approved, rejected)
- lyrics_data (JSONB) — array of {id, start_ms, end_ms, text, confidence}
- source (enum: manual, auto_generated, imported_lrc)
- review_notes (text)
- reviewed_by (FK → users, nullable)
- reviewed_at (timestamp)
- is_canonical (boolean, default false)
- created_at

**song_comments**
- id (UUID, PK)
- song_id (FK → songs)
- user_id (FK → users)
- text (text)
- timestamp_ms (int, nullable) — timestamped comment
- created_at

**broken_track_reports**
- id (UUID, PK)
- song_id (FK → songs)
- reported_by (FK → users)
- reason (text)
- status (enum: open, resolved, dismissed)
- created_at

**invites**
- id (UUID, PK)
- code (text, unique)
- created_by (FK → users)
- used_by (FK → users, nullable)
- expires_at (timestamp)
- created_at

**app_settings**
- key (text, PK)
- value (JSONB)
- updated_by (FK → users)
- updated_at

Key settings: `playback_enabled` (kill switch), `invites_enabled`, `registration_open`

---

## 5. API Contracts (Backend REST)

### Auth
- `POST /api/auth/register` — email + password + invite code
- `POST /api/auth/login` — returns JWT
- `POST /api/auth/refresh` — refresh token
- `GET /api/auth/me` — current user

### Songs
- `GET /api/songs` — paginated, filterable (category, era, search)
- `GET /api/songs/:id` — single song + canonical lyrics
- `GET /api/songs/:id/stream` — **proxied audio stream** (range-request aware)
- `POST /api/songs/:id/report` — report broken track

### Lyrics
- `GET /api/songs/:id/lyrics` — canonical version
- `GET /api/songs/:id/lyrics/versions` — all versions
- `GET /api/songs/:id/lyrics/versions/:versionId` — specific version
- `POST /api/songs/:id/lyrics` — create new version (draft)
- `PUT /api/songs/:id/lyrics/:versionId/submit` — submit for review
- `PUT /api/songs/:id/lyrics/:versionId/approve` — admin approve
- `PUT /api/songs/:id/lyrics/:versionId/reject` — admin reject
- `PUT /api/songs/:id/lyrics/:versionId/revert` — admin revert to this version

### Search
- `GET /api/search?q=...` — fuzzy, alias-aware (proxied to Typesense)

### Admin
- `GET /api/admin/settings` — all settings
- `PUT /api/admin/settings/:key` — update setting (kill switch, etc.)
- `GET /api/admin/users` — user management
- `PUT /api/admin/users/:id/role` — change role
- `GET /api/admin/lyrics/pending` — pending reviews
- `GET /api/admin/analytics` — plays, errors, broken links
- `POST /api/admin/invites` — generate invite code
- `POST /api/admin/sync` — trigger API catalog sync

---

## 6. Frontend Architecture

```
src/
├── app/                    # Next.js App Router
│   ├── (auth)/             # Login, Register
│   ├── (main)/             # Main layout with persistent player
│   │   ├── catalog/        # Browse songs
│   │   ├── song/[id]/      # Song detail + lyrics view
│   │   ├── editor/[id]/    # Lyric sync editor
│   │   ├── search/         # Search results
│   │   └── admin/          # Admin panel
│   └── layout.tsx          # Root layout
├── components/
│   ├── player/             # Audio player, queue, controls
│   ├── lyrics/             # Lyrics display, sync engine
│   ├── editor/             # Waveform, tap-to-time, toolbar
│   ├── catalog/            # Song cards, filters
│   └── ui/                 # Shared UI components
├── lib/
│   ├── audio-engine.ts     # Web Audio API wrapper, drift correction
│   ├── lyric-sync.ts       # Lyric timing engine
│   ├── api-client.ts       # Backend API client
│   └── search.ts           # Typesense client
├── stores/
│   ├── player-store.ts     # Zustand — playback state
│   ├── queue-store.ts      # Queue, shuffle, repeat
│   ├── editor-store.ts     # Editor state, undo/redo
│   └── auth-store.ts       # Auth state
└── styles/
    └── globals.css         # Tailwind + custom theme vars
```

---

## 7. Implementation Priority

### Phase 1 — Foundation (Current)
1. Project scaffold (monorepo)
2. Database setup + migrations
3. Auth system (register, login, RBAC)
4. Song catalog sync from API
5. Basic audio playback with proxy
6. Lyric data model + CRUD

### Phase 2 — The Heart (Lyric Editor)
7. Waveform display (WaveSurfer.js)
8. Tap-to-time mode
9. Lyric line CRUD (add/delete/split/merge)
10. Manual ms editing
11. Offset slider
12. Undo/redo
13. Autosave
14. Submit/review workflow

### Phase 3 — Polish
15. Search (Typesense integration)
16. Queue, shuffle, repeat
17. Admin panel
18. Kill switch
19. Theme system (dark/light)
20. Keyboard shortcuts
21. Community features (comments, reputation)

### Phase 4 — Production
22. Docker containerization
23. Health check jobs
24. Analytics
25. CI/CD
26. Documentation

---

## 8. Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| State management | Zustand | Lightweight, perfect for audio state |
| Waveform | WaveSurfer.js | Battle-tested, supports regions/markers |
| Audio timing | Web Audio API AudioContext | Most accurate clock in the browser |
| Lyrics format | JSONB in PostgreSQL | Flexible, versionable, queryable |
| Search | Typesense | Simpler than Elasticsearch, great fuzzy matching |
| Auth | JWT + httpOnly cookies | Secure, stateless |
| Audio proxy | Express stream pipe | Hides source URLs, handles range requests |
| Monorepo | npm workspaces | Simple, no extra tooling |

---

## 9. Non-Negotiable Safety Features

1. **Kill Switch:** `PUT /api/admin/settings/playback_enabled` → instantly checked on every `/stream` request
2. **Audio Proxy:** Client never sees raw API URLs
3. **Invite-Only:** Registration requires valid invite code
4. **Rate Limiting:** express-rate-limit on all endpoints
5. **RBAC:** Middleware checks role on every protected route
6. **No Downloads:** Stream-only, no `Content-Disposition: attachment`

---

*This plan is the foundation. Phase 1 scaffold follows immediately.*
