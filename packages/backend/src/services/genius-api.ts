/**
 * Genius API Service
 * Fetches lyrics from Genius when the Juice WRLD API doesn't have them.
 * Uses the Client Access Token for server-side requests.
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
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];

    const data = await res.json() as GeniusSearchResponse;
    return data.response?.hits || [];
  } catch {
    return [];
  }
}

/**
 * Search for a Juice WRLD song on Genius and return the best match URL
 */
export async function findJuiceWrldSong(songName: string): Promise<{ url: string; geniusId: number } | null> {
  // Try exact search first
  const hits = await searchGenius(`Juice WRLD ${songName}`);

  for (const hit of hits) {
    const artist = hit.result.primary_artist.name.toLowerCase();
    const title = hit.result.title.toLowerCase();

    // Must be a Juice WRLD song
    if (artist.includes('juice') || title.includes('juice wrld')) {
      return { url: hit.result.url, geniusId: hit.result.id };
    }
  }

  // Try without "Juice WRLD" prefix (some songs are under features)
  const hits2 = await searchGenius(songName);
  for (const hit of hits2) {
    const artist = hit.result.primary_artist.name.toLowerCase();
    if (artist.includes('juice')) {
      return { url: hit.result.url, geniusId: hit.result.id };
    }
  }

  return null;
}

/**
 * Scrape lyrics text from a Genius song page URL.
 * Genius doesn't provide lyrics via API — we fetch the page and extract text.
 */
export async function scrapeLyricsFromUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return null;

    const html = await res.text();

    // Extract lyrics from the page — Genius wraps lyrics in data-lyrics-container divs
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
    .replace(/&nbsp;/g, ' ');

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
