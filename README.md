# 🧃 JuiceVault

**Private, invite-only Juice WRLD lyrics-first music vault.**

Premium playback + perfectly timed, line-by-line lyric sync.
Built on the [Juice WRLD Community API](https://juicewrldapi.com).

---

## How to Set Up (For Non-Coders)

### What You Need Installed

1. **Node.js** (v18 or newer) — [Download here](https://nodejs.org)
2. **Docker Desktop** — [Download here](https://www.docker.com/products/docker-desktop/)
3. **Git** (optional) — for version control

### Step-by-Step Setup

#### 1. Open a terminal in this folder

On Windows: Right-click the `juicevault` folder → "Open in Terminal"
Or: Open PowerShell/Command Prompt and `cd` to this folder.

#### 2. Start the databases (PostgreSQL + Redis)

```bash
docker compose up -d
```

This starts PostgreSQL (your database) and Redis (your cache) in the background.
Wait ~10 seconds for them to fully start.

#### 3. Install all dependencies

```bash
npm install
```

#### 4. Set up the database tables

```bash
cd packages/backend
cp .env.example .env
npx prisma migrate dev --name init
```

#### 5. Seed the database with an admin account

```bash
npx tsx prisma/seed.ts
```

This creates:
- **Admin account:** `admin@juicevault.app` / `admin123`
- **Invite codes:** `JUICE999`, `VAULT2026`, `WRLD999`

#### 6. Start the backend server

```bash
npm run dev
```

The backend will start at `http://localhost:4000`.

#### 7. Sync songs from the Juice WRLD API

In a **new terminal window** (keep the backend running):

```bash
cd packages/backend
npx tsx src/jobs/sync-catalog.ts --max-pages=5
```

This pulls songs from the API into your local database.
- `--max-pages=5` limits it to ~250 songs for testing.
- Remove `--max-pages` to sync everything (~39,000+ songs, takes a while).
- Add `--category=released` to only sync released tracks.

#### 8. Test it

Open your browser to `http://localhost:4000/api/health` — you should see:
```json
{"status":"ok","timestamp":"...","version":"0.1.0"}
```

---


## Push Local Folder to GitHub (Windows Quick Commands)

If your updated files are on your PC in `C:\Users\jayto\Desktop\juicevault`, run these in **PowerShell**:

```powershell
cd C:\Users\jayto\Desktop\juicevault
git status
git add -A
git commit -m "Update JuiceVault"
git push origin main
```

If this is your first push from that machine and `origin` is missing:

```powershell
cd C:\Users\jayto\Desktop\juicevault
git remote add origin https://github.com/jayton123456789-hub/juicevault.git
git branch -M main
git push -u origin main
```

If PowerShell says **"not a git repository"**, you are in the wrong folder. `cd` into the folder that contains the hidden `.git` directory, then rerun the commands.

## Project Structure

```
juicevault/
├── docker-compose.yml          ← Databases (PostgreSQL, Redis)
├── packages/
│   ├── backend/                ← Node.js + Express + TypeScript
│   │   ├── prisma/
│   │   │   ├── schema.prisma   ← Database schema (all tables)
│   │   │   └── seed.ts         ← Creates admin + invite codes
│   │   └── src/
│   │       ├── index.ts        ← Express server entry point
│   │       ├── config/         ← Database, Redis, env configs
│   │       ├── middleware/     ← Auth, RBAC, kill switch
│   │       ├── routes/         ← All API endpoints
│   │       ├── services/       ← Juice WRLD API wrapper
│   │       └── jobs/           ← Catalog sync job
│   └── frontend/               ← Next.js (coming next)
├── API_AUDIT.md                ← What I got wrong and corrected
└── TECHNICAL_PLAN.md           ← Full architecture document
```

## Key Decisions

| What | Choice | Why |
|------|--------|-----|
| Audio streaming | Proxy through `/api/songs/:id/stream` | Client never sees the external API URL |
| Lyrics | Raw text from API + our timed overlay | API already has lyrics; we add timing |
| Auth | JWT in httpOnly cookies | Secure, standard |
| Kill switch | `PUT /api/admin/settings/playback_enabled` | Checked on every stream request |

## API Endpoints (Backend)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register (needs invite code) |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Current user |
| GET | `/api/songs` | Browse catalog |
| GET | `/api/songs/:id` | Song detail |
| GET | `/api/songs/:id/stream` | **Audio stream (proxied)** |
| GET | `/api/songs/:id/cover-art` | Cover art (proxied) |
| GET | `/api/songs/:songId/lyrics` | Get timed lyrics |
| POST | `/api/songs/:songId/lyrics` | Create lyrics version |
| PUT | `/api/songs/:songId/lyrics/:vId` | Update draft |
| PUT | `/api/songs/:songId/lyrics/:vId/submit` | Submit for review |
| GET | `/api/search?q=...` | Search songs |
| GET | `/api/radio/random` | Random playable song |
| GET | `/api/admin/settings` | View settings |
| PUT | `/api/admin/settings/playback_enabled` | **KILL SWITCH** |
| POST | `/api/admin/invites` | Generate invite codes |
| GET | `/api/admin/analytics` | Dashboard stats |

---

*Phase 1 complete. Frontend + Lyric Editor coming next.*
