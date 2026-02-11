-- Add local cover path to songs
ALTER TABLE "songs" ADD COLUMN IF NOT EXISTS "local_cover_path" TEXT NOT NULL DEFAULT '';

-- Enhance broken track reports with detailed error info
ALTER TABLE "broken_track_reports" ADD COLUMN IF NOT EXISTS "api_url" TEXT NOT NULL DEFAULT '';
ALTER TABLE "broken_track_reports" ADD COLUMN IF NOT EXISTS "proxy_error" TEXT NOT NULL DEFAULT '';
ALTER TABLE "broken_track_reports" ADD COLUMN IF NOT EXISTS "error_log" TEXT NOT NULL DEFAULT '';
ALTER TABLE "broken_track_reports" ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMP(3);
ALTER TABLE "broken_track_reports" ADD COLUMN IF NOT EXISTS "resolved_by" TEXT;
