# JuiceVault Issues - Analysis and Fix Plan

## Critical Finding: Cover Art Not Showing in Grid View

### Root Cause Identified

**The CSS (line 5053-5054):**
```css
.song-card-art img { opacity: 0; transition: opacity 0.3s; }
.song-card-art img.loaded { opacity: 1; }
```

**The Problem:**
- All images in grid cards start with `opacity: 0` (invisible)
- They need the `loaded` class to become visible
- The `artTag()` function generates `<img>` tags WITHOUT an `onload` handler
- Result: Real cover images load but never become visible (stay at opacity 0)
- User sees only the CSS background placeholder

**The artTag function (line 8514-8519):**
```javascript
function artTag(s, fallback) {
  const placeholderSrc = '/assets/JuiceVaultAlbumCoverPlaceHolder.png';
  const src = artSrc(s);
  if (!src) return `<img src="${placeholderSrc}" loading="lazy">`;
  return `<img src="${src}" onerror="this.src='${placeholderSrc}'" loading="lazy">`;
}
```

**Missing:** `onload="this.classList.add('loaded')"` on both img tags

---

## Issues Reported by User

### 1. ✅ COVER ART PRIORITY (CONFIRMED BUG)
**Status:** CSS/Image loading issue, NOT a priority logic issue

**What user sees:** Placeholder showing instead of metadata covers
**Actual problem:** Images load but stay invisible due to missing `loaded` class
**Data flow is correct:** `imageUrl` from API → stored in DB → returned by backend → used by `artSrc()`

**Fix needed:**
```javascript
// Add onload handler to artTag function
if (!src) return `<img src="${placeholderSrc}" loading="lazy" onload="this.classList.add('loaded')">`;
return `<img src="${src}" onerror="this.src='${placeholderSrc}'" loading="lazy" onload="this.classList.add('loaded')">`;
```

---

### 2. 🔄 PERFORMANCE/CRASHING WHEN CLICKING FAST
**Status:** Needs investigation

**Symptoms:**
- Clicking play on radio then skipping quickly causes crashes
- Website becomes unresponsive
- Requires page reload

**Potential causes:**
1. Multiple audio elements being created
2. Race conditions in `playSong()` 
3. Rapid API calls overwhelming the browser
4. Memory leaks from event listeners
5. Queue manipulation conflicts

**Investigation needed:**
- Check if audio events are properly cleaned up
- Check for multiple concurrent play requests
- Check error handling in rapid succession

---

### 3. ❓ NOT ALL SONGS SHOWING COVERS
**Status:** Need more info

**Questions:**
- Are these songs missing `imageUrl` in the database?
- Are the `imageUrl` values valid/accessible?
- Do these songs have `hasFilePath = false`?

**Debug approach:**
- Check browser network tab for failed image requests
- Verify `imageUrl` values in API responses
- Check if `artSrc()` is returning empty string for some songs

---

### 4. ❓ PLAYLIST ISSUES
**Status:** Partially working per user

**Working:**
- Creating playlists ✓
- Adding songs to playlists ✓
- Liking songs ✓

**Not working:**
- Deleting playlists
- Opening playlist detail page

**Potential causes:**
- Missing API endpoints for delete
- JavaScript errors in playlist detail rendering
- Event handler issues

---

## Data Flow Verification (CORRECT)

```
External API (juicewrldapi.com)
    ↓ (sync-catalog.ts fetches)
API returns: image_url (e.g., "/assets/youtube.webp")
    ↓ (fixImageUrl() converts)
Stored in DB: imageUrl (e.g., "https://juicewrldapi.com/assets/youtube.webp")
    ↓ (backend routes return)
Frontend receives: { ..., imageUrl: "https://juicewrldapi.com/assets/youtube.webp", ... }
    ↓ (artSrc() uses)
Priority: localCoverPath > imageUrl > embedded cover > placeholder
    ↓ (artTag() renders)
<img src="https://juicewrldapi.com/assets/youtube.webp">
    ↓ (CSS should show)
opacity: 1 when .loaded class added ❌ MISSING THIS STEP
```

---

## Recommended Fix Order

### Phase 1: Critical Fix (Cover Art)
**ONE LINE CHANGE ONLY** - Add `onload` handler to `artTag()` function
- File: `packages/backend/public/index.html`
- Line: ~8517-8518
- Change: Add `onload="this.classList.add('loaded')"` to both img tags

### Phase 2: Investigation (Before any code changes)
1. Test cover art fix
2. Verify which songs have missing covers (browser dev tools)
3. Check for JavaScript errors when clicking fast
4. Test playlist delete functionality

### Phase 3: Performance Fixes (if needed)
- Debounce rapid clicks
- Add loading states
- Clean up audio event listeners

---

## What NOT to Do (Lessons Learned)

❌ Don't rewrite entire functions
❌ Don't add new features while fixing bugs  
❌ Don't change multiple things at once
❌ Don't assume the data flow is broken when it's a UI issue

✅ Do make minimal, surgical changes
✅ Do test each change individually
✅ Do understand the existing code before modifying
✅ Do verify data flow before changing logic
