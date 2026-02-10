# 🚀 Deploy JuiceVault to the Internet

## What You Need (Before Starting)
- A **GitHub account** (free) — [github.com](https://github.com)
- A **Render account** (free) — [render.com](https://render.com)
- About **15 minutes**

---

## Step 1: Push Your Code to GitHub

### First time? Install Git:
1. Download Git from [git-scm.com](https://git-scm.com/download/win)
2. Install it (click Next through everything)
3. Restart your terminal/PowerShell

### Create a GitHub repo:
1. Go to [github.com/new](https://github.com/new)
2. Name it `juicevault`
3. Set it to **Public** (Render free tier needs public repos)
4. Do NOT check "Add README" (we already have one)
5. Click **Create repository**

### Push your code:
Open PowerShell in your project folder (`C:\Users\jayto\Desktop\juicevault`) and run:

```powershell
git init
git add .
git commit -m "Initial commit - JuiceVault v1"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/juicevault.git
git push -u origin main
```

> ⚠️ Replace `YOUR_USERNAME` with your actual GitHub username!

### Verify:
- Go to your GitHub repo page
- You should see all your files (but NOT `.env` — that's private!)

---

## Step 2: Deploy on Render (One-Click Blueprint)

### Option A: Automatic Blueprint Deploy (Easiest)
1. Go to [render.com](https://render.com) and sign up (use GitHub login)
2. Click **New → Blueprint**
3. Connect your `juicevault` repo
4. Render reads `render.yaml` and auto-creates:
   - ✅ PostgreSQL database (free)
   - ✅ Web service (free)
   - ✅ All environment variables
5. Click **Apply**
6. Wait ~3-5 minutes for the build

### Option B: Manual Setup (If Blueprint Doesn't Work)

#### Create the Database:
1. Render Dashboard → **New → PostgreSQL**
2. Name: `juicevault-db`
3. Database: `juicevault`
4. User: `juicevault`
5. Plan: **Free**
6. Click **Create Database**
7. Copy the **External Database URL** (starts with `postgresql://`)

#### Create the Web Service:
1. Render Dashboard → **New → Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Name:** `juicevault`
   - **Root Directory:** `packages/backend`
   - **Runtime:** Node
   - **Build Command:** `npm install && npx prisma generate && npx prisma migrate deploy && npx tsc`
   - **Start Command:** `node dist/index.js`
   - **Plan:** Free
4. Add **Environment Variables:**

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `10000` |
| `DATABASE_URL` | *(paste the PostgreSQL URL from step 7 above)* |
| `REDIS_URL` | *(leave empty)* |
| `JWT_SECRET` | *(click "Generate" or type a long random string)* |
| `JWT_EXPIRES_IN` | `7d` |
| `JUICEWRLD_API_BASE` | `https://juicewrldapi.com/juicewrld` |
| `FRONTEND_URL` | `https://juicevault.onrender.com` |
| `ASSEMBLYAI_API_KEY` | `fd8ce1591cb643cb9bd64a88f02e51df` |

5. Click **Create Web Service**

---

## Step 3: First-Time Setup (After Deploy)

Once the build finishes (~3-5 min), your site is live at:
**https://juicevault.onrender.com**

But the database is empty! You need to sync the song catalog:

### Sync Songs (Using Render Shell):
1. Go to your web service on Render
2. Click **Shell** tab (top right)
3. Run these commands:

```bash
npx tsx src/jobs/sync-catalog.ts
```

This pulls the full Juice WRLD catalog from the API into your database.
It takes about 1-2 minutes.

### Create Your Admin Account:
1. Go to your live site
2. Register a new account (any email/password)
3. To make yourself admin, go to Render Shell and run:

```bash
npx tsx -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.user.updateMany({ where: { email: 'YOUR_EMAIL' }, data: { role: 'admin' } }).then(r => console.log('Done:', r));
"
```

> Replace `YOUR_EMAIL` with the email you registered with.

---

## Step 4: Custom Domain (Optional)

### Free Subdomain:
Your site is already live at `juicevault.onrender.com` — no setup needed!

### Custom Domain ($1-12/year):
1. Buy a domain from [Namecheap](https://namecheap.com) or [Cloudflare](https://dash.cloudflare.com)
   - Cheap options: `juicevault.site` (~$2/yr), `juicevault.xyz` (~$2/yr)
   - Premium: `juicevault.com` (~$10/yr), `thejuicevault.com`
2. In Render Dashboard → Your service → **Settings → Custom Domains**
3. Add your domain
4. Render gives you a CNAME record to add at your domain registrar
5. Update `FRONTEND_URL` env var to match your new domain
6. SSL/HTTPS is automatic!

---

## 🔧 Troubleshooting

### "Build failed"
- Check the build logs in Render Dashboard
- Most common: missing dependency — make sure `package.json` is correct
- Try clicking **Manual Deploy → Clear build cache & deploy**

### "Application error" on the site
- Check the **Logs** tab in Render
- Usually a missing environment variable — double-check all env vars

### Site is slow to load first time
- Free tier apps **sleep after 15 min of no traffic**
- First visit after sleep takes ~30 seconds to wake up
- Fix: Upgrade to Starter ($7/mo) for always-on, OR use a free pinger like [UptimeRobot](https://uptimerobot.com) to keep it awake

### Songs don't play
- Make sure you ran the catalog sync (`npx tsx src/jobs/sync-catalog.ts`)
- Audio streams from the Juice WRLD API — if their API is down, streams won't work

### Database expired (after 30 days on free tier)
- Render's free PostgreSQL expires after 30 days
- You can create a new one and re-run migrations + catalog sync
- Or upgrade to paid DB ($7/mo) for permanent storage

---

## 📊 Cost Summary

| Component | Free Tier | Paid (Recommended) |
|-----------|-----------|-------------------|
| Web Service | Free (sleeps after 15 min) | $7/mo (always on) |
| PostgreSQL | Free (expires in 30 days) | $7/mo (permanent) |
| Custom Domain | `.onrender.com` free | $2-12/year |
| **Total** | **$0** | **~$14/mo + domain** |

---

## 🔄 Updating Your Site

After making changes locally:

```powershell
git add .
git commit -m "describe your changes"
git push
```

Render auto-deploys on every push to `main`. Your site updates in ~2-3 minutes.

---

## 🎉 That's It!

Your JuiceVault is now live on the internet. Share the link with anyone! 🧃
