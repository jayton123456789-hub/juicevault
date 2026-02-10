/**
 * Genius API Service - ULTRA Enhanced Version
 * Fetches lyrics from Genius with aggressive unreleased song detection
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
 * Search Genius for a song by title
 */
export async function searchGenius(query: string): Promise<GeniusSearchHit[]> {
  const token = getGeniusToken();
  if (!token) return [];

  try {
    const res = await fetch(`${GENIUS_BASE}/search?q=${encodeURIComponent(query)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return [];

    const data = await res.json() as GeniusSearchResponse;
    return data.response?.hits || [];
  } catch {
    return [];
  }
}

/**
 * Check if artist is Juice WRLD or related
 */
function isJuiceWrldArtist(artistName: string): boolean {
  const lower = artistName.toLowerCase();
  return lower.includes('juice') || 
         lower.includes('wrld') || 
         lower.includes('999') ||
         lower.includes('jarad') ||
         lower.includes('bibby') ||
         lower.includes('grade a');
}

/**
 * Check if artist could be a feature collaborator
 */
function isCollaboratorArtist(artistName: string): boolean {
  const lower = artistName.toLowerCase();
  const collaborators = [
    'nicki minaj', 'future', 'young thug', 'travis scott', 
    'lil uzi vert', 'polo g', 'marshmello', 'elton john',
    'benny blanco', 'clever', 'chain smokers', 'halsey',
    'seezyn', 'suga', 'bts', 'ellie goulding', 'weeknd',
    'drake', 'lil durk', 'gunna', 'nav', 'trippie redd',
    'lil tecca', 'nba youngboy', 'ynw', 'ski mask', 'xxx',
    'carnage', 'waka flocka', 'g herbo', 'lil yachty',
    'kodak black', ' Offset', 'quavo', 'takeoff', 'migos'
  ];
  return collaborators.some(c => lower.includes(c));
}

/**
 * Calculate similarity between two strings (0-1)
 */
function similarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().replace(/[^\w]/g, '');
  const s2 = str2.toLowerCase().replace(/[^\w]/g, '');
  
  if (s1 === s2) return 1;
  if (s1.length < 3 || s2.length < 3) return 0;
  
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  
  const matrix: number[][] = [];
  for (let i = 0; i <= s1.length; i++) matrix[i] = [i];
  for (let j = 0; j <= s2.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  
  const maxLen = Math.max(s1.length, s2.length);
  return 1 - matrix[s1.length][s2.length] / maxLen;
}

/**
 * Aggressively clean song name for searching
 */
function cleanSongName(name: string): { base: string; variations: string[] } {
  const variations: string[] = [];
  
  // Remove file extensions
  let cleaned = name.replace(/\.(mp3|wav|flac|m4a)$/i, '');
  
  // Original after extension removal
  variations.push(cleaned.trim());
  
  // Remove parentheses content (v1, v2, feat. etc)
  cleaned = cleaned.replace(/\([^)]*\)/g, '');
  variations.push(cleaned.trim());
  
  // Remove bracket content [v1], [feat.], etc
  cleaned = cleaned.replace(/\[[^\]]*\]/g, '');
  variations.push(cleaned.trim());
  
  // Remove feat/ft/prod
  cleaned = cleaned.replace(/\s+(feat|ft|prod)\.?\s*.*$/i, '');
  variations.push(cleaned.trim());
  
  // Remove "with" artist
  cleaned = cleaned.replace(/\s+with\s+.*$/i, '');
  variations.push(cleaned.trim());
  
  // Get just the first part (in case of dashes, pipes, etc)
  const firstPart = cleaned.split(/[-|]/)[0].trim();
  if (firstPart && firstPart.length > 2 && !variations.includes(firstPart)) {
    variations.push(firstPart);
  }
  
  // Remove numbers at end
  const noNumbers = cleaned.replace(/\s+\d+$/g, '').trim();
  if (noNumbers && noNumbers.length > 2 && !variations.includes(noNumbers)) {
    variations.push(noNumbers);
  }
  
  // Final base name
  const base = cleaned.trim();
  
  // Remove duplicates and empty
  const unique = [...new Set(variations.filter(v => v.length > 2))];
  
  return { base, variations: unique };
}

/**
 * Search for a Juice WRLD song on Genius with AGGRESSIVE strategies
 */
export async function findJuiceWrldSong(songName: string): Promise<{ url: string; geniusId: number } | null> {
  const { base, variations } = cleanSongName(songName);
  
  console.log(`[GENIUS] Searching for "${songName}" - variations:`, variations);
  
  const triedUrls = new Set<string>();
  
  // Strategy 1: Try all variations with "Juice WRLD" prefix
  for (const variation of variations.slice(0, 3)) {
    const hits = await searchGenius(`Juice WRLD ${variation}`);
    
    for (const hit of hits.slice(0, 5)) {
      const artist = hit.result.primary_artist.name;
      const title = hit.result.title;
      const url = hit.result.url;
      
      if (triedUrls.has(url)) continue;
      
      // Match if it's Juice or a known collaborator
      if (isJuiceWrldArtist(artist) || isCollaboratorArtist(artist)) {
        const titleSim = similarity(title, base);
        const titleSimOriginal = similarity(title, songName);
        
        if (titleSim > 0.5 || titleSimOriginal > 0.5) {
          console.log(`[GENIUS] ✅ Found: "${title}" by ${artist} (sim: ${Math.max(titleSim, titleSimOriginal).toFixed(2)})`);
          return { url, geniusId: hit.result.id };
        }
      }
    }
  }
  
  // Strategy 2: Try variations without artist (catches "Song (feat. Juice WRLD)" on other artist pages)
  for (const variation of variations.slice(0, 3)) {
    const hits = await searchGenius(variation);
    
    for (const hit of hits.slice(0, 5)) {
      const artist = hit.result.primary_artist.name;
      const title = hit.result.title;
      const url = hit.result.url;
      
      if (triedUrls.has(url)) continue;
      triedUrls.add(url);
      
      // Look for Juice WRLD in title OR artist
      const titleLower = title.toLowerCase();
      const artistLower = artist.toLowerCase();
      
      const hasJuiceInTitle = titleLower.includes('juice') || titleLower.includes('wrld');
      const isJuiceArtist = isJuiceWrldArtist(artist);
      const isCollabArtist = isCollaboratorArtist(artist);
      
      if (hasJuiceInTitle || isJuiceArtist || isCollabArtist) {
        const titleSim = similarity(title, base);
        const titleSimOriginal = similarity(title, songName);
        
        if (titleSim > 0.6 || titleSimOriginal > 0.6 || 
            titleLower.includes(base.toLowerCase()) ||
            base.toLowerCase().includes(titleLower.replace(/[^\w]/g, ''))) {
          console.log(`[GENIUS] ✅ Found (no prefix): "${title}" by ${artist}`);
          return { url, geniusId: hit.result.id };
        }
      }
    }
  }
  
  // Strategy 3: Try with "unreleased" tag
  for (const variation of [base, variations[0]]) {
    const hits = await searchGenius(`Juice WRLD ${variation} unreleased`);
    
    for (const hit of hits.slice(0, 3)) {
      if (isJuiceWrldArtist(hit.result.primary_artist.name)) {
        console.log(`[GENIUS] ✅ Found (unreleased tag): "${hit.result.title}"`);
        return { url: hit.result.url, geniusId: hit.result.id };
      }
    }
  }
  
  // Strategy 4: Try with "leaked" or "leak" tag
  for (const variation of [base, variations[0]]) {
    const hits = await searchGenius(`Juice WRLD ${variation} leak`);
    
    for (const hit of hits.slice(0, 3)) {
      if (isJuiceWrldArtist(hit.result.primary_artist.name)) {
        console.log(`[GENIUS] ✅ Found (leak tag): "${hit.result.title}"`);
        return { url: hit.result.url, geniusId: hit.result.id };
      }
    }
  }
  
  // Strategy 5: Try first word only + Juice WRLD (for long song names)
  const firstWord = base.split(' ')[0];
  if (firstWord && firstWord.length > 3) {
    const hits = await searchGenius(`Juice WRLD ${firstWord}`);
    
    for (const hit of hits.slice(0, 3)) {
      const title = hit.result.title;
      if (isJuiceWrldArtist(hit.result.primary_artist.name)) {
        // Check if the full base name is contained in the result
        const titleClean = title.toLowerCase().replace(/[^\w]/g, '');
        const baseClean = base.toLowerCase().replace(/[^\w]/g, '');
        
        if (titleClean.includes(baseClean) || baseClean.includes(titleClean)) {
          console.log(`[GENIUS] ✅ Found (first word): "${title}"`);
          return { url: hit.result.url, geniusId: hit.result.id };
        }
      }
    }
  }
  
  console.log(`[GENIUS] ❌ Not found: "${songName}"`);
  return null;
}

/**
 * Scrape lyrics text from a Genius song page URL.
 */
export async function scrapeLyricsFromUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      console.log(`[GENIUS] Scrape failed: ${res.status} for ${url}`);
      return null;
    }

    const html = await res.text();
    const lyrics = extractLyricsFromHtml(html);
    
    if (lyrics) {
      console.log(`[GENIUS] Scraped ${lyrics.length} chars from ${url}`);
    } else {
      console.log(`[GENIUS] No lyrics found on page: ${url}`);
    }
    
    return lyrics;
  } catch (err: any) {
    console.log(`[GENIUS] Scrape error: ${err?.message} for ${url}`);
    return null;
  }
}

/**
 * Extract lyrics text from Genius HTML page
 */
function extractLyricsFromHtml(html: string): string | null {
  // Try multiple selectors for different Genius page versions
  
  // Method 1: data-lyrics-container (most common)
  const containerRegex = /data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
  const containers: string[] = [];
  let match;

  while ((match = containerRegex.exec(html)) !== null) {
    containers.push(match[1]);
  }

  // Method 2: Lyrics__Container class
  if (!containers.length) {
    const oldRegex = /class="Lyrics__Container[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    while ((match = oldRegex.exec(html)) !== null) {
      containers.push(match[1]);
    }
  }
  
  // Method 3: Any Lyrics_ class
  if (!containers.length) {
    const reactRegex = /class="[^"]*Lyrics_[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((match = reactRegex.exec(html)) !== null) {
      containers.push(match[1]);
    }
  }
  
  // Method 4: Try finding lyrics in JSON-LD
  if (!containers.length) {
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (jsonLdMatch) {
      try {
        const data = JSON.parse(jsonLdMatch[1]);
        if (data['@type'] === 'MusicRecording' && data.recordingOf?.lyrics?.text) {
          return data.recordingOf.lyrics.text;
        }
      } catch {}
    }
  }

  if (!containers.length) return null;

  // Clean HTML to plain text
  let text = containers.join('\n');

  // Replace <br> with newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, (match) => {
      const code = parseInt(match.slice(2, -1), 10);
      return String.fromCharCode(code);
    });

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text.length > 20 ? text : null;
}

/**
 * Full pipeline: Search Genius for a song, scrape lyrics
 */
export async function fetchGeniusLyrics(songName: string): Promise<{
  lyrics: string;
  geniusUrl: string;
  geniusId: number;
} | null> {
  const found = await findJuiceWrldSong(songName);
  if (!found) return null;

  const lyrics = await scrapeLyricsFromUrl(found.url);
  if (!lyrics) return null;

  return {
    lyrics,
    geniusUrl: found.url,
    geniusId: found.geniusId,
  };
}
