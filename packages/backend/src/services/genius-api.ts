/**
 * Genius API Service - Enhanced Version
 * Fetches lyrics from Genius with better unreleased song detection
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
         lower.includes('bibby') || // Grade A
         lower.includes('lil bibby');
}

/**
 * Calculate similarity between two strings (0-1)
 */
function similarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().replace(/[^\w]/g, '');
  const s2 = str2.toLowerCase().replace(/[^\w]/g, '');
  
  if (s1 === s2) return 1;
  if (s1.length < 3 || s2.length < 3) return 0;
  
  // Check if one contains the other
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  
  // Levenshtein distance
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
 * Clean song name for better searching
 */
function cleanSongName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, '') // Remove parentheses
    .replace(/\[[^\]]*\]/g, '') // Remove brackets
    .replace(/feat\..*$/i, '') // Remove feat.
    .replace(/ft\..*$/i, '') // Remove ft.
    .replace(/prod\..*$/i, '') // Remove prod.
    .replace(/\.mp3$/i, '')
    .replace(/\.wav$/i, '')
    .trim();
}

/**
 * Search for a Juice WRLD song on Genius with multiple strategies
 */
export async function findJuiceWrldSong(songName: string): Promise<{ url: string; geniusId: number } | null> {
  const cleanedName = cleanSongName(songName);
  
  // Strategy 1: Direct "Juice WRLD [song]" search
  let hits = await searchGenius(`Juice WRLD ${cleanedName}`);
  
  for (const hit of hits.slice(0, 5)) {
    const artist = hit.result.primary_artist.name;
    const title = hit.result.title;
    
    if (isJuiceWrldArtist(artist)) {
      const titleSim = similarity(title, cleanedName);
      if (titleSim > 0.6) {
        return { url: hit.result.url, geniusId: hit.result.id };
      }
    }
  }
  
  // Strategy 2: Just the song name (for features or alternative listings)
  hits = await searchGenius(cleanedName);
  
  for (const hit of hits.slice(0, 5)) {
    const artist = hit.result.primary_artist.name;
    const title = hit.result.title;
    
    if (isJuiceWrldArtist(artist)) {
      const titleSim = similarity(title, cleanedName);
      if (titleSim > 0.6) {
        return { url: hit.result.url, geniusId: hit.result.id };
      }
    }
  }
  
  // Strategy 3: Search with "unreleased" tag (common for leaks)
  hits = await searchGenius(`Juice WRLD ${cleanedName} unreleased`);
  
  for (const hit of hits.slice(0, 3)) {
    const artist = hit.result.primary_artist.name;
    if (isJuiceWrldArtist(artist)) {
      return { url: hit.result.url, geniusId: hit.result.id };
    }
  }
  
  // Strategy 4: Search with "leak" tag
  hits = await searchGenius(`Juice WRLD ${cleanedName} leak`);
  
  for (const hit of hits.slice(0, 3)) {
    const artist = hit.result.primary_artist.name;
    if (isJuiceWrldArtist(artist)) {
      return { url: hit.result.url, geniusId: hit.result.id };
    }
  }
  
  // Strategy 5: Loose match - any Juice WRLD song with partial title match
  hits = await searchGenius(`Juice WRLD ${cleanedName.split(' ')[0]}`);
  
  for (const hit of hits.slice(0, 3)) {
    const artist = hit.result.primary_artist.name;
    const title = hit.result.title;
    
    if (isJuiceWrldArtist(artist)) {
      const titleSim = similarity(title, cleanedName);
      if (titleSim > 0.7) {
        return { url: hit.result.url, geniusId: hit.result.id };
      }
    }
  }
  
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
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) return null;

    const html = await res.text();
    const lyrics = extractLyricsFromHtml(html);
    return lyrics;
  } catch {
    return null;
  }
}

/**
 * Extract lyrics text from Genius HTML page
 */
function extractLyricsFromHtml(html: string): string | null {
  // Genius uses data-lyrics-container="true" divs
  const containerRegex = /data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
  const containers: string[] = [];
  let match;

  while ((match = containerRegex.exec(html)) !== null) {
    containers.push(match[1]);
  }

  if (!containers.length) {
    // Fallback: try the older Lyrics__Container class
    const oldRegex = /class="Lyrics__Container[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    while ((match = oldRegex.exec(html)) !== null) {
      containers.push(match[1]);
    }
  }
  
  // Fallback 2: Try new React-based structure
  if (!containers.length) {
    const reactRegex = /class="[^"]*Lyrics_[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((match = reactRegex.exec(html)) !== null) {
      containers.push(match[1]);
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
