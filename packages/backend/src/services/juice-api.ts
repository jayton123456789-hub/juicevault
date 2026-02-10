/**
 * JuiceWrldApiService
 * 
 * Wraps the community Juice WRLD API at https://juicewrldapi.com/juicewrld/
 * 
 * CANONICAL SOURCE: The uploaded JuiceWRLDAPIdocs.txt file.
 * Every endpoint, parameter, and response shape here comes directly from that document.
 * 
 * KEY FACTS:
 * - Base URL: https://juicewrldapi.com/juicewrld
 * - No authentication required
 * - Pagination is Django REST Framework style: { count, next, previous, results }
 * - Audio streaming is via GET /files/download/?path={file_path} with Range header support
 * - Songs have a "path" field that IS the file path for streaming
 * - The API has raw lyrics text on the song model
 * - Search normalizes special characters ("dont" matches "don't")
 */

import { getEnv } from '../config/env';
import { cacheGet, cacheSet } from '../config/redis';

// ─── Response Types (match API exactly) ─────────────────

/** Django REST Framework paginated response */
export interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** Era as returned nested inside a Song */
export interface ApiSongEra {
  id: number;
  name: string;
  description: string;
  time_frame: string;
  play_count: number;
}

/** Full Song model from the API — every field from the docs */
export interface ApiSong {
  id: number;                    // Internal DB id
  public_id: number;             // Public-facing id
  name: string;                  // Song title
  original_key: string;          // Original JSON key
  category: 'released' | 'unreleased' | 'unsurfaced' | 'recording_session';
  path: string;                  // FILE PATH for streaming — e.g. "Compilation/1. Released.../song.mp3"
  era: ApiSongEra;
  track_titles: string[];        // Array of alternate titles / aliases
  credited_artists: string;
  producers: string;
  engineers: string;
  recording_locations: string;
  record_dates: string;
  length: string;                // Duration as string like "3:59"
  bitrate: string;
  additional_information: string;
  file_names: string;            // Can be array if file_names_array=true
  instrumentals: string;
  preview_date: string;
  release_date: string;
  dates: string;
  session_titles: string;
  session_tracking: string;
  instrumental_names: string;
  notes: string;                 // Combined notes (JSON string)
  lyrics: string;                // RAW LYRICS TEXT — the API has these!
  snippets: unknown[];
  date_leaked: string;
  leak_type: string;
  image_url: string;             // Era-based image URL
}

/** Compact song as returned in paginated list (fewer fields) */
export interface ApiSongListItem {
  id: number;
  name: string;
  category: string;
  era: { name: string };
  credited_artists: string;
  producers: string;
  // List endpoint returns fewer fields than detail endpoint
  [key: string]: unknown;
}

/** Era from GET /eras/ */
export interface ApiEra {
  id: number;
  name: string;
  description: string;
  time_frame: string;
}

/** Category from GET /categories/ */
export interface ApiCategory {
  value: string;
  label: string;
}

/** Stats from GET /stats/ */
export interface ApiStats {
  total_songs: number;
  category_stats: Record<string, number>;
  era_stats: Record<string, number>;
}

/** Radio random song from GET /radio/random/ */
export interface ApiRadioSong {
  id: string;        // This is the file path ID, not the song DB id
  title: string;
  path: string;
  size: number;
  modified: string;
  hash: string;
  song: ApiSong;     // Full song metadata
}

/** File browser item from GET /files/browse/ */
export interface ApiFileItem {
  type: 'file' | 'directory';
  name: string;
  path: string;
  size?: number;
  modified?: string;
}

/** File browser response */
export interface ApiFileBrowseResponse {
  items: ApiFileItem[];
  path: string;
}

// ─── Service ────────────────────────────────────────────

export class JuiceWrldApiService {
  private baseUrl: string;

  constructor() {
    // CORRECT base URL: https://juicewrldapi.com/juicewrld
    this.baseUrl = getEnv().JUICEWRLD_API_BASE;
  }

  // ─── HTTP helper ────────────────────────────────────

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    // Ensure path starts with /
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;

    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          'Accept': 'application/json',
          ...init?.headers,
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`API ${response.status}: ${response.statusText} — ${text.slice(0, 200)}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      console.error(`[JuiceAPI] Request failed: ${url}`, error);
      throw error;
    }
  }

  // ─── Songs ──────────────────────────────────────────

  /**
   * GET /songs/
   * Paginated song list with optional filtering.
   * 
   * Response is Django-style: { count, next, previous, results: [...] }
   */
  async getSongs(params?: {
    page?: number;
    page_size?: number;
    category?: string;
    era?: string;
    search?: string;
    searchall?: string;
    lyrics?: string;
    file_names_array?: boolean;
  }): Promise<PaginatedResponse<ApiSongListItem>> {
    const cacheKey = `jw:songs:${JSON.stringify(params || {})}`;
    const cached = await cacheGet<PaginatedResponse<ApiSongListItem>>(cacheKey);
    if (cached) return cached;

    const query = new URLSearchParams();
    if (params?.page) query.set('page', String(params.page));
    if (params?.page_size) query.set('page_size', String(params.page_size));
    if (params?.category) query.set('category', params.category);
    if (params?.era) query.set('era', params.era);
    if (params?.search) query.set('search', params.search);
    if (params?.searchall) query.set('searchall', params.searchall);
    if (params?.lyrics) query.set('lyrics', params.lyrics);
    if (params?.file_names_array) query.set('file_names_array', 'true');

    const qs = query.toString();
    const result = await this.request<PaginatedResponse<ApiSongListItem>>(
      `/songs/${qs ? '?' + qs : ''}`
    );

    await cacheSet(cacheKey, result, 600); // 10 min cache
    return result;
  }

  /**
   * GET /songs/{id}/
   * Full song detail by internal API id.
   */
  async getSong(id: number): Promise<ApiSong> {
    const cacheKey = `jw:song:${id}`;
    const cached = await cacheGet<ApiSong>(cacheKey);
    if (cached) return cached;

    const result = await this.request<ApiSong>(`/songs/${id}/`);
    await cacheSet(cacheKey, result, 600);
    return result;
  }

  // ─── Statistics ─────────────────────────────────────

  /** GET /stats/ */
  async getStats(): Promise<ApiStats> {
    const cacheKey = 'jw:stats';
    const cached = await cacheGet<ApiStats>(cacheKey);
    if (cached) return cached;

    const result = await this.request<ApiStats>('/stats/');
    await cacheSet(cacheKey, result, 1800); // 30 min
    return result;
  }

  // ─── Categories ─────────────────────────────────────

  /** GET /categories/ — returns { categories: [{value, label}, ...] } */
  async getCategories(): Promise<ApiCategory[]> {
    const cacheKey = 'jw:categories';
    const cached = await cacheGet<ApiCategory[]>(cacheKey);
    if (cached) return cached;

    const result = await this.request<{ categories: ApiCategory[] }>('/categories/');
    await cacheSet(cacheKey, result.categories, 3600); // 1 hour
    return result.categories;
  }

  // ─── Eras ───────────────────────────────────────────

  /** GET /eras/ — returns array of era objects directly */
  async getEras(): Promise<ApiEra[]> {
    const cacheKey = 'jw:eras';
    const cached = await cacheGet<ApiEra[]>(cacheKey);
    if (cached) return cached;

    const result = await this.request<ApiEra[]>('/eras/');
    await cacheSet(cacheKey, result, 3600); // 1 hour
    return result;
  }

  // ─── Audio Streaming ────────────────────────────────
  // CRITICAL: Audio is served via GET /files/download/?path={file_path}
  // The song's "path" field IS the file_path parameter.
  // Range requests are supported (returns 206 Partial Content).
  // Our backend proxies this — the frontend never hits the API directly.

  /**
   * Build the full download/stream URL for a given file path.
   * This URL is used by our audio proxy to fetch audio from the API.
   */
  getStreamUrl(filePath: string): string {
    const encodedPath = encodeURIComponent(filePath);
    return `${this.baseUrl}/files/download/?path=${encodedPath}`;
  }

  /**
   * Fetch raw audio bytes with optional range header.
   * Returns the raw Response object so we can pipe it to the client.
   */
  async fetchAudioStream(filePath: string, rangeHeader?: string): Promise<Response> {
    const url = this.getStreamUrl(filePath);
    const headers: Record<string, string> = {};
    if (rangeHeader) {
      headers['Range'] = rangeHeader;
    }

    const response = await fetch(url, { headers });

    // 200 = full file, 206 = partial content — both are valid
    if (!response.ok && response.status !== 206) {
      const error = new Error(`Audio stream failed: ${response.status} ${response.statusText}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }

    return response;
  }

  // ─── Cover Art ──────────────────────────────────────

  /** GET /files/cover-art/?path={audio_file_path} */
  async fetchCoverArt(filePath: string): Promise<Response> {
    const encodedPath = encodeURIComponent(filePath);
    const url = `${this.baseUrl}/files/cover-art/?path=${encodedPath}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Cover art fetch failed: ${response.status}`);
    }
    return response;
  }

  // ─── File Browser ───────────────────────────────────

  /** GET /files/browse/?path={dir}&search={filter} */
  async browseFiles(path?: string, search?: string): Promise<ApiFileBrowseResponse> {
    const query = new URLSearchParams();
    if (path) query.set('path', path);
    if (search) query.set('search', search);

    const qs = query.toString();
    return this.request<ApiFileBrowseResponse>(`/files/browse/${qs ? '?' + qs : ''}`);
  }

  /** GET /files/info/?path={file_path} */
  async getFileInfo(filePath: string): Promise<unknown> {
    const query = new URLSearchParams({ path: filePath });
    return this.request<unknown>(`/files/info/?${query.toString()}`);
  }

  // ─── Radio ──────────────────────────────────────────

  /** GET /radio/random/ — random playable song with full metadata */
  async getRandomSong(): Promise<ApiRadioSong> {
    // Don't cache radio — it should be random each time
    return this.request<ApiRadioSong>('/radio/random/');
  }

  // ─── Shared Playlists ──────────────────────────────

  /** POST /playlists/share/ */
  async createSharedPlaylist(data: unknown): Promise<unknown> {
    return this.request<unknown>('/playlists/share/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  /** GET /playlists/shared/{share_id}/ */
  async getSharedPlaylist(shareId: string): Promise<unknown> {
    return this.request<unknown>(`/playlists/shared/${shareId}/`);
  }

  /** GET /playlists/shared/{share_id}/info/ */
  async getShareInfo(shareId: string): Promise<unknown> {
    return this.request<unknown>(`/playlists/shared/${shareId}/info/`);
  }

  // ─── Health Check ───────────────────────────────────

  async checkHealth(): Promise<boolean> {
    try {
      await this.request<unknown>('/stats/');
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Singleton ──────────────────────────────────────────

let _instance: JuiceWrldApiService;
export function getJuiceApi(): JuiceWrldApiService {
  if (!_instance) {
    _instance = new JuiceWrldApiService();
  }
  return _instance;
}
