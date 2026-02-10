/**
 * Genius API Service - AGGRESSIVE Search Edition
 * 
 * STEP 1: Use Genius API /search to find song URLs
 * STEP 2: Scrape HTML to extract lyrics from data-lyrics-container
 * 
 * NEVER expects lyrics from API - only metadata!
 */

const GENIUS_BASE = 'https://api.genius.com';

function getGeniusToken(): string {
  return process.env.GENIUS_ACCESS_TOKEN || '';
}

interface GeniusSearchHit {
  result: {
    id: number;
    title: string;
    primary_artist: { name: string };
    url: string;
    lyrics_state: string;
  };
}

interface GeniusSearchResponse {
  response: {
    hits: GeniusSearchHit[];
  };
}

/**
 * STEP 1A: Search Genius API for songs
 * Returns metadata only - NO LYRICS!
 */
async function searchGeniusApi(query: string): Promise<GeniusSearchHit[]> {
  const token = getGeniusToken();
  if (!token) {
    console.log('[GENIUS] No token configured');
    return [];
  }

  try {
    const url = `${GENIUS_BASE}/search?q=${encodeURIComponent(query)}`;
    console.log(`[GENIUS] API Search: "${query}"`);
    
    const res = await fetch(url, {
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.log(`[GENIUS] API Error: ${res.status} for "${query}"`);
      return [];
    }

    const data = await res.json() as GeniusSearchResponse;
    const hits = data.response?.hits || [];
    console.log(`[GENIUS] API returned ${hits.length} hits for "${query}"`);
    return hits;
  } catch (err: any) {
    console.log(`[GENIUS] API Exception: ${err?.message} for "${query}"`);
    return [];
  }
}

/**
 * Check if artist could be Juice WRLD related
 */
function isJuiceWrldRelated(artistName: string): boolean {
  if (!artistName) return false;
  const lower = artistName.toLowerCase();
  
  // Direct matches
  if (lower.includes('juice') || lower.includes('wrld') || lower.includes('999')) return true;
  
  // Collaborators who frequently work with Juice
  const collabs = [
    'nicki minaj', 'future', 'young thug', 'travis scott', 
    'lil uzi vert', 'polo g', 'marshmello', 'elton john',
    'benny blanco', 'clever', 'chain smokers', 'halsey',
    'seezyn', 'suga', 'bts', 'ellie goulding', 'weeknd',
    'drake', 'lil durk', 'gunna', 'nav', 'trippie redd',
    'lil tecca', 'nba youngboy', 'ynw', 'ski mask', 'xxx',
    'carnage', 'waka flocka', 'g herbo', 'lil yachty',
    'kodak black', 'offset', 'quavo', 'takeoff', 'migos',
    'grade a', 'lil bibby'
  ];
  
  return collabs.some(c => lower.includes(c));
}

/**
 * Clean song name and generate variations
 */
function generateSearchVariations(songName: string): string[] {
  const variations = new Set<string>();
  
  // Original
  variations.add(songName.trim());
  
  // Remove file extensions
  const noExt = songName.replace(/\.(mp3|wav|flac|m4a|mp4)$/i, '').trim();
  if (noExt !== songName) variations.add(noExt);
  
  // Remove parentheses (v1, feat., etc)
  const noParens = noExt.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (noParens.length > 2) variations.add(noParens);
  
  // Remove brackets [v1], [feat.], etc
  const noBrackets = noParens.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim();
  if (noBrackets.length > 2) variations.add(noBrackets);
  
  // Remove feat/ft/prod
  const noFeat = noBrackets.replace(/\s+(feat|ft|prod|featuring)\.?\s*.*/i, '').trim();
  if (noFeat.length > 2) variations.add(noFeat);
  
  // Remove "with" artist
  const noWith = noFeat.replace(/\s+with\s+.*$/i, '').trim();
  if (noWith.length > 2) variations.add(noWith);
  
  // First 3 words only (for long titles)
  const words = noWith.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 3) {
    variations.add(words.slice(0, 3).join(' '));
    variations.add(words.slice(0, 2).join(' '));
  }
  
  // First word only (for very long titles)
  if (words[0] && words[0].length > 3) {
    variations.add(words[0]);
  }
  
  // Remove trailing numbers
  const noNumbers = noWith.replace(/\s+\d+\s*$/g, '').trim();
  if (noNumbers !== noWith && noNumbers.length > 2) {
    variations.add(noNumbers);
  }
  
  return Array.from(variations).filter(v => v.length > 1);
}

/**
 * Check if title matches our search
 */
function titlesMatch(resultTitle: string, searchName: string): boolean {
  const r = resultTitle.toLowerCase().replace(/[^\w]/g, '');
  const s = searchName.toLowerCase().replace(/[^\w]/g, '');
  
  // Exact match
  if (r === s) return true;
  
  // Contains
  if (r.includes(s) || s.includes(r)) return true;
  
  // Levenshtein distance for fuzzy match
  const dist = levenshteinDistance(r, s);
  const maxLen = Math.max(r.length, s.length);
  const similarity = 1 - dist / maxLen;
  
  return similarity > 0.75; // 75% similar
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

/**
 * STEP 1B: Find the best matching Genius URL for a song
 * Tries multiple search strategies aggressively
 */
export async function findGeniusUrl(songName: string): Promise<string | null> {
  console.log(`\n[GENIUS] ====== Searching for: "${songName}" ======`);
  
  const variations = generateSearchVariations(songName);
  console.log(`[GENIUS] Variations to try:`, variations.slice(0, 5));
  
  const triedUrls = new Set<string>();
  
  // STRATEGY 1: Try all variations with "Juice WRLD" prefix
  console.log(`[GENIUS] --- Strategy 1: "Juice WRLD" + variations ---`);
  for (const variation of variations.slice(0, 4)) {
    const hits = await searchGeniusApi(`Juice WRLD ${variation}`);
    
    for (const hit of hits) {
      const artist = hit.result.primary_artist.name;
      const title = hit.result.title;
      const url = hit.result.url;
      
      if (triedUrls.has(url)) continue;
      
      // Must be Juice or collaborator
      if (!isJuiceWrldRelated(artist)) continue;
      
      // Check title match
      for (const v of variations) {
        if (titlesMatch(title, v)) {
          console.log(`[GENIUS] ✅ STRATEGY 1 MATCH: "${title}" by ${artist}`);
          console.log(`[GENIUS] URL: ${url}`);
          return url;
        }
      }
      
      triedUrls.add(url);
    }
  }
  
  // STRATEGY 2: Try variations WITHOUT artist prefix
  // This finds songs like "Nicki Minaj - Arctic Tundra (feat. Juice WRLD)"
  console.log(`[GENIUS] --- Strategy 2: Variations only (catches features) ---`);
  for (const variation of variations.slice(0, 4)) {
    const hits = await searchGeniusApi(variation);
    
    for (const hit of hits.slice(0, 8)) {
      const artist = hit.result.primary_artist.name;
      const title = hit.result.title;
      const url = hit.result.url;
      
      if (triedUrls.has(url)) continue;
      triedUrls.add(url);
      
      // Skip if not Juice-related
      if (!isJuiceWrldRelated(artist) && !title.toLowerCase().includes('juice')) {
        continue;
      }
      
      // Check if title contains our song name
      for (const v of variations) {
        if (titlesMatch(title, v)) {
          console.log(`[GENIUS] ✅ STRATEGY 2 MATCH: "${title}" by ${artist}`);
          console.log(`[GENIUS] URL: ${url}`);
          return url;
        }
      }
      
      // Also check if the CLEANED title matches
      const cleanTitle = title.toLowerCase().replace(/[^\w]/g, '');
      for (const v of variations) {
        const cleanV = v.toLowerCase().replace(/[^\w]/g, '');
        if (cleanTitle.includes(cleanV) || cleanV.includes(cleanTitle)) {
          console.log(`[GENIUS] ✅ STRATEGY 2a MATCH: "${title}" by ${artist}`);
          console.log(`[GENIUS] URL: ${url}`);
          return url;
        }
      }
    }
  }
  
  // STRATEGY 3: Try with "unreleased" tag
  console.log(`[GENIUS] --- Strategy 3: Adding "unreleased" tag ---`);
  for (const variation of [variations[0], variations[1]].filter(Boolean)) {
    const hits = await searchGeniusApi(`Juice WRLD ${variation} unreleased`);
    
    for (const hit of hits.slice(0, 3)) {
      if (isJuiceWrldRelated(hit.result.primary_artist.name)) {
        console.log(`[GENIUS] ✅ STRATEGY 3 MATCH: "${hit.result.title}"`);
        return hit.result.url;
      }
    }
  }
  
  // STRATEGY 4: Try with "leaked" tag
  console.log(`[GENIUS] --- Strategy 4: Adding "leaked" tag ---`);
  for (const variation of [variations[0], variations[1]].filter(Boolean)) {
    const hits = await searchGeniusApi(`Juice WRLD ${variation} leaked`);
    
    for (const hit of hits.slice(0, 3)) {
      if (isJuiceWrldRelated(hit.result.primary_artist.name)) {
        console.log(`[GENIUS] ✅ STRATEGY 4 MATCH: "${hit.result.title}"`);
        return hit.result.url;
      }
    }
  }
  
  // STRATEGY 5: Very loose first-word search
  console.log(`[GENIUS] --- Strategy 5: First word loose match ---`);
  const firstWord = variations[variations.length - 1]; // Last variation is usually single word
  if (firstWord && firstWord.length > 3) {
    const hits = await searchGeniusApi(`Juice WRLD ${firstWord}`);
    
    for (const hit of hits.slice(0, 5)) {
      const artist = hit.result.primary_artist.name;
      const title = hit.result.title;
      
      if (!isJuiceWrldRelated(artist)) continue;
      
      // Very loose matching
      const cleanTitle = title.toLowerCase().replace(/[^\w]/g, '');
      const searchClean = songName.toLowerCase().replace(/[^\w]/g, '');
      
      if (cleanTitle.includes(firstWord.toLowerCase()) ||
          searchClean.includes(cleanTitle.slice(0, 10))) {
        console.log(`[GENIUS] ✅ STRATEGY 5 MATCH: "${title}"`);
        return hit.result.url;
      }
    }
  }
  
  console.log(`[GENIUS] ❌ ALL STRATEGIES FAILED for "${songName}"`);
  return null;
}

/**
 * STEP 2: Scrape lyrics from Genius HTML page
 * This is the ONLY way to get lyrics!
 */
export async function scrapeLyricsFromUrl(url: string): Promise<string | null> {
  console.log(`[GENIUS] Scraping: ${url}`);
  
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      console.log(`[GENIUS] HTTP ${res.status} for ${url}`);
      return null;
    }

    const html = await res.text();
    console.log(`[GENIUS] Downloaded ${html.length} bytes`);
    
    const lyrics = extractLyricsFromHtml(html);
    
    if (lyrics) {
      const lines = lyrics.split('\n').filter(l => l.trim());
      console.log(`[GENIUS] ✅ Extracted ${lyrics.length} chars, ${lines.length} lines`);
      
      // Quality check
      if (lines.length < 10) {
        console.log(`[GENIUS] ⚠️ Too few lines (${lines.length}), probably not real lyrics`);
        return null;
      }
      
      return lyrics;
    } else {
      console.log(`[GENIUS] ❌ No lyrics found in HTML`);
      return null;
    }
  } catch (err: any) {
    console.log(`[GENIUS] ❌ Scrape error: ${err?.message}`);
    return null;
  }
}

/**
 * Extract lyrics from Genius HTML
 * MUST find data-lyrics-container elements
 */
function extractLyricsFromHtml(html: string): string | null {
  const containers: string[] = [];
  
  // METHOD 1: data-lyrics-container="true" (current standard)
  const regex1 = /data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
  let match;
  while ((match = regex1.exec(html)) !== null) {
    containers.push(match[1]);
  }
  console.log(`[GENIUS] Method 1 (data-lyrics-container): ${containers.length} containers`);
  
  // METHOD 2: Lyrics__Container class (older pages)
  if (containers.length === 0) {
    const regex2 = /class="Lyrics__Container[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    while ((match = regex2.exec(html)) !== null) {
      containers.push(match[1]);
    }
    console.log(`[GENIUS] Method 2 (Lyrics__Container): ${containers.length} containers`);
  }
  
  // METHOD 3: Any Lyrics_ class
  if (containers.length === 0) {
    const regex3 = /class="[^"]*Lyrics_[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((match = regex3.exec(html)) !== null) {
      containers.push(match[1]);
    }
    console.log(`[GENIUS] Method 3 (Lyrics_*): ${containers.length} containers`);
  }
  
  if (containers.length === 0) {
    console.log(`[GENIUS] No lyric containers found in HTML`);
    return null;
  }
  
  // Clean and combine
  let text = containers.join('\n');
  
  // Replace <br> with newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  
  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, '');
  
  // Decode HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1), 10)));
  
  // Clean whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  
  return text.length > 50 ? text : null;
}

/**
 * FULL PIPELINE: Find URL + Scrape lyrics
 */
export async function fetchGeniusLyrics(songName: string): Promise<{
  lyrics: string;
  geniusUrl: string;
} | null> {
  // STEP 1: Find the URL using API
  const url = await findGeniusUrl(songName);
  if (!url) return null;
  
  // STEP 2: Scrape lyrics from HTML
  const lyrics = await scrapeLyricsFromUrl(url);
  if (!lyrics) return null;
  
  return { lyrics, geniusUrl: url };
}
