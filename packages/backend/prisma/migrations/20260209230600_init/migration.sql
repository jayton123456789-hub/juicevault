-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'trusted_contributor', 'user');

-- CreateEnum
CREATE TYPE "SongCategory" AS ENUM ('released', 'unreleased', 'unsurfaced', 'recording_session');

-- CreateEnum
CREATE TYPE "LyricsStatus" AS ENUM ('draft', 'pending_review', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "LyricsSource" AS ENUM ('manual', 'auto_generated', 'imported_lrc', 'imported_api');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "invited_by" TEXT,
    "reputation_score" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "used_by" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eras" (
    "id" TEXT NOT NULL,
    "external_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "time_frame" TEXT NOT NULL DEFAULT '',
    "play_count" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "eras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "songs" (
    "id" TEXT NOT NULL,
    "external_id" INTEGER NOT NULL,
    "public_id" INTEGER,
    "original_key" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "category" "SongCategory" NOT NULL DEFAULT 'unreleased',
    "file_path" TEXT,
    "era_id" TEXT,
    "credited_artists" TEXT NOT NULL DEFAULT '',
    "producers" TEXT NOT NULL DEFAULT '',
    "engineers" TEXT NOT NULL DEFAULT '',
    "recording_location" TEXT NOT NULL DEFAULT '',
    "record_dates" TEXT NOT NULL DEFAULT '',
    "length" TEXT NOT NULL DEFAULT '',
    "bitrate" TEXT NOT NULL DEFAULT '',
    "additional_info" TEXT NOT NULL DEFAULT '',
    "file_names" TEXT NOT NULL DEFAULT '',
    "instrumentals" TEXT NOT NULL DEFAULT '',
    "preview_date" TEXT NOT NULL DEFAULT '',
    "release_date" TEXT NOT NULL DEFAULT '',
    "dates" TEXT NOT NULL DEFAULT '',
    "session_titles" TEXT NOT NULL DEFAULT '',
    "session_tracking" TEXT NOT NULL DEFAULT '',
    "instrumental_names" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "raw_lyrics" TEXT NOT NULL DEFAULT '',
    "date_leaked" TEXT NOT NULL DEFAULT '',
    "leak_type" TEXT NOT NULL DEFAULT '',
    "image_url" TEXT NOT NULL DEFAULT '',
    "snippets" JSONB NOT NULL DEFAULT '[]',
    "duration_ms" INTEGER,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "last_health_check" TIMESTAMP(3),
    "play_count" INTEGER NOT NULL DEFAULT 0,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "songs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "song_aliases" (
    "id" TEXT NOT NULL,
    "song_id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "song_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lyrics_versions" (
    "id" TEXT NOT NULL,
    "song_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "LyricsStatus" NOT NULL DEFAULT 'draft',
    "lyrics_data" JSONB NOT NULL,
    "source" "LyricsSource" NOT NULL DEFAULT 'manual',
    "review_notes" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "is_canonical" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lyrics_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "song_comments" (
    "id" TEXT NOT NULL,
    "song_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "timestamp_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "song_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broken_track_reports" (
    "id" TEXT NOT NULL,
    "song_id" TEXT NOT NULL,
    "reported_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broken_track_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invites_code_key" ON "invites"("code");

-- CreateIndex
CREATE UNIQUE INDEX "invites_used_by_key" ON "invites"("used_by");

-- CreateIndex
CREATE UNIQUE INDEX "eras_external_id_key" ON "eras"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "songs_external_id_key" ON "songs"("external_id");

-- CreateIndex
CREATE INDEX "songs_category_idx" ON "songs"("category");

-- CreateIndex
CREATE INDEX "songs_name_idx" ON "songs"("name");

-- CreateIndex
CREATE INDEX "songs_file_path_idx" ON "songs"("file_path");

-- CreateIndex
CREATE INDEX "song_aliases_alias_idx" ON "song_aliases"("alias");

-- CreateIndex
CREATE INDEX "song_aliases_song_id_idx" ON "song_aliases"("song_id");

-- CreateIndex
CREATE INDEX "lyrics_versions_song_id_is_canonical_idx" ON "lyrics_versions"("song_id", "is_canonical");

-- CreateIndex
CREATE INDEX "lyrics_versions_status_idx" ON "lyrics_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "lyrics_versions_song_id_version_number_key" ON "lyrics_versions"("song_id", "version_number");

-- CreateIndex
CREATE INDEX "song_comments_song_id_idx" ON "song_comments"("song_id");

-- CreateIndex
CREATE INDEX "broken_track_reports_status_idx" ON "broken_track_reports"("status");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_fkey" FOREIGN KEY ("used_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "songs" ADD CONSTRAINT "songs_era_id_fkey" FOREIGN KEY ("era_id") REFERENCES "eras"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "song_aliases" ADD CONSTRAINT "song_aliases_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "songs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lyrics_versions" ADD CONSTRAINT "lyrics_versions_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "songs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lyrics_versions" ADD CONSTRAINT "lyrics_versions_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lyrics_versions" ADD CONSTRAINT "lyrics_versions_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "song_comments" ADD CONSTRAINT "song_comments_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "songs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "song_comments" ADD CONSTRAINT "song_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broken_track_reports" ADD CONSTRAINT "broken_track_reports_song_id_fkey" FOREIGN KEY ("song_id") REFERENCES "songs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broken_track_reports" ADD CONSTRAINT "broken_track_reports_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
