/**
 * Genius API Service - Correct 2-Step Implementation
 * 
 * Step 1: Search API to find potential URLs
 * Step 2: Scrape HTML to verify lyrics exist
 * 
 * NEVER trust search metadata - only HTML confirms lyrics!
 */

const GENIUS_BASE = 'https://api.genius.com';

function getGeniusToken(): string {
  return process.env.GENIUS_ACCESS_TOKEN || '';
}

interface GeniusHit {
  result: {
    id: number;
    title: string;
    url: string;
    primary_artist: {
      name: string;
    };
  };
}

interface GeniusSearchResponse {
  response: {
    hits: GeniusHit[];
  };
}

/**
 * Step 1: Search Genius API for song URLs
 * Returns metadata only - NO LYRICS in API!
 */
async function geniusSearch(query: string): Promise<GeniusHit[]> {
  const token = getGeniusToken();
  if (!token) return [];

  try {
    const res = await fetch(
      `${GENIUS_BASE}/search?q=${encodeURIComponent(query)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!res.ok) return [];
    const data = (await res.json()) as GeniusSearchResponse;
    return data.response?.hits || [];
  } catch {
    return [];
  }
}

/**
 * Normalize song title for comparison
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\.mp3$/i, '')
    .replace(/\.wav$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate string similarity (0-1)
 */
function similarity(a: string, b: string): number {
  const s1 = a.replace(/[^\w]/g, '');
  const s2 = b.replace(/[^\w]/g, '');
  
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;
  
  // Simple contains check
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  
  // Levenshtein
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
  
  return 1 - matrix[s1.length][s2.length] / Math.max(s1.length, s2.length);
}

/**
 * Check if result is Juice WRLD related (loose matching)
 */
function isJuiceWrldRelated(hit: GeniusHit): boolean {
  const primary = hit.result.primary_artist.name.toLowerCase();
  const url = hit.result.url.toLowerCase();
  const title = hit.result.title.toLowerCase();
  
  // Primary artist is Juice
  if (primary.includes('juice') || primary.includes('wrld')) return true;
  
  // URL contains juice-wrld
  if (url.includes('juice-wrld')) return true;
  
  // Title contains Juice WRLD (for features on other pages)
  if (title.includes('juice wrld')) return true;
  
  // Known collaborators (loose list)
  const collabs = ['nicki minaj', 'future', 'young thug', 'marshmello', 
                   'elton john', 'benny blanco', 'halsey', 'weeknd', 'drake'];
  if (collabs.some(c => primary.includes(c))) return true;
  
  return false;
}

/**
 * Step 2: Scrape lyrics from HTML page
 * ONLY way to get lyrics - API never returns them!
 */
export async function scrapeLyricsFromUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) return null;
    const html = await res.text();
    
    // Extract from data-lyrics-container elements
    const containers: string[] = [];
    const regex = /data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      containers.push(match[1]);
    }
    
    if (containers.length === 0) return null;
    
    // Clean HTML to text
    let text = containers.join('\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    
    // Quality check
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 10) return null;
    
    return text;
  } catch {
    return null;
  }
}

/**
 * FULL PIPELINE: Find URL via API + Scrape lyrics via HTML
 * 
 * Correct algorithm:
 * 1. Normalize song title
 * 2. Try a few search queries
 * 3. For each result: check title similarity + artist match
 * 4. Scrape HTML to verify lyrics exist
 * 5. Return first valid result
 */
export async function fetchGeniusLyrics(songName: string): Promise<{
  lyrics: string;
  geniusUrl: string;
} | null> {
  
  const normalized = normalizeTitle(songName);
  
  // Generate search queries (clean, simple)
  const queries = [
    normalized + ' Juice WRLD',
    normalized,
    'Juice WRLD ' + normalized,
  ];
  
  for (const query of queries) {
    const hits = await geniusSearch(query);
    
    for (const hit of hits.slice(0, 5)) {
      // Check title similarity
      const titleSim = similarity(normalizeTitle(hit.result.title), normalized);
      if (titleSim < 0.6) continue;
      
      // Check artist is Juice-related (loose)
      if (!isJuiceWrldRelated(hit)) continue;
      
      // CRITICAL: Scrape to verify lyrics actually exist!
      const lyrics = await scrapeLyricsFromUrl(hit.result.url);
      if (lyrics) {
        return {
          lyrics,
          geniusUrl: hit.result.url,
        };
      }
    }
  }
  
  return null;
}
