/**
 * Lyric Aligner Service
 * Uses AssemblyAI's free tier (185 hours) to generate word-level timestamps
 * for songs that have both rawLyrics and filePath.
 *
 * Flow:
 * 1. Get audio stream URL for a song
 * 2. Submit to AssemblyAI for transcription with word-level timestamps
 * 3. Align AssemblyAI's transcription with our known lyrics (forced alignment via matching)
 * 4. Store as LyricsVersion with lyricsData = [{start_ms, end_ms, text}]
 *
 * IMPORTANT: API key is read lazily (at call time), NOT at module load time,
 * so dotenv can be loaded before this module is imported.
 */

const ASSEMBLYAI_BASE = 'https://api.assemblyai.com/v2';

// ─── Types ──────────────────────────────────────────────

interface AAIWord {
  text: string;
  start: number;  // ms
  end: number;    // ms
  confidence: number;
}

interface AAITranscript {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string;
  words?: AAIWord[];
  error?: string;
}

interface TimedLine {
  start_ms: number;
  end_ms: number;
  text: string;
  confidence: number;
}

// ─── Helpers ────────────────────────────────────────────

/** Read API key lazily so dotenv has time to load */
function getApiKey(): string {
  const key = process.env.ASSEMBLYAI_API_KEY || '';
  if (!key) throw new Error('ASSEMBLYAI_API_KEY is not set in environment');
  return key;
}

// ─── AssemblyAI API Calls ───────────────────────────────

/**
 * Submit an audio URL to AssemblyAI for transcription
 */
async function submitTranscription(audioUrl: string): Promise<string> {
  const apiKey = getApiKey();

  const res = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      language_code: 'en',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AssemblyAI submit failed (${res.status}): ${body}`);
  }

  const data: any = await res.json();
  return data.id;
}

/**
 * Poll AssemblyAI until transcription completes
 */
async function pollTranscription(transcriptId: string, maxWaitMs = 300000): Promise<AAITranscript> {
  const apiKey = getApiKey();
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${ASSEMBLYAI_BASE}/transcript/${transcriptId}`, {
      headers: { 'Authorization': apiKey },
    });

    if (!res.ok) {
      throw new Error(`AssemblyAI poll failed (${res.status})`);
    }

    const data = await res.json() as AAITranscript;

    if (data.status === 'completed') return data;

    if (data.status === 'error') {
      throw new Error(`AssemblyAI transcription error: ${data.error}`);
    }

    // Wait 3 seconds before next poll
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  throw new Error('AssemblyAI transcription timed out after 5 minutes');
}

/**
 * Get SRT content from AssemblyAI for a completed transcript
 */
async function getSrt(transcriptId: string): Promise<string> {
  const apiKey = getApiKey();

  const res = await fetch(`${ASSEMBLYAI_BASE}/transcript/${transcriptId}/srt`, {
    headers: { 'Authorization': apiKey },
  });

  if (!res.ok) {
    throw new Error(`AssemblyAI SRT fetch failed (${res.status})`);
  }

  return res.text();
}

// ─── Lyrics Alignment ───────────────────────────────────

/**
 * Align AssemblyAI's word-level timestamps with our known lyrics lines.
 *
 * Strategy:
 * - Split rawLyrics into lines
 * - Walk through AAI words sequentially
 * - For each lyric line, find the best matching sequence of AAI words
 * - Use fuzzy matching to handle minor transcription differences
 *   (Juice WRLD lyrics often have slang that ASR slightly mishears)
 */
function alignWordsToLyrics(words: AAIWord[], rawLyrics: string): TimedLine[] {
  const lines = rawLyrics.split('\n').filter(l => l.trim().length > 0);
  if (!words.length || !lines.length) return [];

  const result: TimedLine[] = [];
  let wordIdx = 0;

  for (const line of lines) {
    const lineWords = line.trim().toLowerCase().replace(/[^\w\s']/g, '').split(/\s+/).filter(Boolean);
    if (!lineWords.length) continue;

    // Find the best starting position for this line in the AAI words
    const bestStart = findBestMatch(words, wordIdx, lineWords);

    if (bestStart >= 0) {
      const lineWordCount = Math.min(lineWords.length, words.length - bestStart);
      const startWord = words[bestStart];
      const endWord = words[Math.min(bestStart + lineWordCount - 1, words.length - 1)];

      const avgConfidence = words
        .slice(bestStart, bestStart + lineWordCount)
        .reduce((sum, w) => sum + w.confidence, 0) / lineWordCount;

      result.push({
        start_ms: startWord.start,
        end_ms: endWord.end,
        text: line.trim(),
        confidence: Math.round(avgConfidence * 100) / 100,
      });

      wordIdx = bestStart + lineWordCount;
    } else {
      // No match found — estimate from surrounding lines
      if (result.length > 0) {
        const lastLine = result[result.length - 1];
        const gapMs = 500;
        const estimatedDuration = lineWords.length * 300; // ~300ms per word

        result.push({
          start_ms: lastLine.end_ms + gapMs,
          end_ms: lastLine.end_ms + gapMs + estimatedDuration,
          text: line.trim(),
          confidence: 0,
        });
      } else {
        // First line with no match — start from 0
        const estimatedDuration = lineWords.length * 300;
        result.push({
          start_ms: 0,
          end_ms: estimatedDuration,
          text: line.trim(),
          confidence: 0,
        });
      }
    }
  }

  return result;
}

/**
 * Find the best starting position for a sequence of words in the AAI output.
 * Uses a sliding window with Levenshtein-based similarity scoring.
 */
function findBestMatch(words: AAIWord[], startFrom: number, targetWords: string[]): number {
  if (!targetWords.length) return -1;

  const searchWindow = Math.min(50, words.length - startFrom);
  let bestScore = -1;
  let bestPos = -1;

  for (let i = startFrom; i < Math.min(startFrom + searchWindow, words.length); i++) {
    let score = 0;
    const matchLen = Math.min(targetWords.length, words.length - i);

    for (let j = 0; j < matchLen; j++) {
      const aaiWord = words[i + j].text.toLowerCase().replace(/[^\w']/g, '');
      const targetWord = targetWords[j];

      if (aaiWord === targetWord) {
        score += 1.0;
      } else if (levenshteinSimilarity(aaiWord, targetWord) > 0.7) {
        score += 0.7;
      }
    }

    const normalizedScore = score / targetWords.length;

    if (normalizedScore > bestScore && normalizedScore > 0.3) {
      bestScore = normalizedScore;
      bestPos = i;
    }

    // Perfect match — stop early
    if (normalizedScore > 0.9) break;
  }

  return bestPos;
}

/**
 * Simple Levenshtein similarity (0-1)
 */
function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

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

  return 1 - matrix[a.length][b.length] / Math.max(a.length, b.length);
}

// ─── Main Export ────────────────────────────────────────

/**
 * Generate timed lyrics for a song.
 * @param audioUrl - Public URL to the audio file (must be fetchable by AssemblyAI)
 * @param rawLyrics - Known lyrics text
 * @returns Array of timed lines + SRT string, or null if failed
 */
export async function generateTimedLyrics(
  audioUrl: string,
  rawLyrics: string
): Promise<{ timedLines: TimedLine[]; srt: string } | null> {
  // Validate API key at call time (not module load)
  getApiKey();

  // 1. Submit for transcription
  const transcriptId = await submitTranscription(audioUrl);

  // 2. Poll until complete
  const transcript = await pollTranscription(transcriptId);

  if (!transcript.words?.length) {
    console.warn('  ⚠ AssemblyAI returned no words for this audio');
    return null;
  }

  // 3. Align AAI words with our known lyrics
  const timedLines = alignWordsToLyrics(transcript.words, rawLyrics);

  // 4. Get SRT for storage
  const srt = await getSrt(transcriptId);

  return { timedLines, srt };
}

export { TimedLine, AAIWord };
