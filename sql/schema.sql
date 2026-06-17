-- MoodFilm-DBMS Schema
-- Run this in Supabase SQL Editor

-- ─────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    TEXT UNIQUE NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS favorites (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    movie_id      INTEGER NOT NULL,
    movie_title   TEXT NOT NULL,
    poster_path   TEXT,
    vote_average  NUMERIC(3,1),
    added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, movie_id)
);

CREATE TABLE IF NOT EXISTS mood_history (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mood          TEXT NOT NULL,
    input_text    TEXT,
    confidence    NUMERIC(5,2),
    logged_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS search_logs (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    query         TEXT NOT NULL,
    result_count  INTEGER DEFAULT 0,
    searched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_favorites_user       ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_mood_history_user    ON mood_history(user_id);
CREATE INDEX IF NOT EXISTS idx_mood_history_logged  ON mood_history(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_logs_user     ON search_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_search_logs_query    ON search_logs(query);

-- ─────────────────────────────────────────────
-- VIEW — mood_trends
-- ─────────────────────────────────────────────

CREATE OR REPLACE VIEW mood_trends AS
SELECT
    mood,
    COUNT(*)                                          AS total_count,
    ROUND(AVG(confidence), 2)                         AS avg_confidence,
    COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '7 days')  AS last_7_days,
    COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '30 days') AS last_30_days
FROM mood_history
GROUP BY mood
ORDER BY total_count DESC;

-- ─────────────────────────────────────────────
-- TRIGGER — update last_active on any activity
-- ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_last_active()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    UPDATE users SET last_active = NOW() WHERE id = NEW.user_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_favorites_last_active    ON favorites;
DROP TRIGGER IF EXISTS trg_mood_history_last_active ON mood_history;
DROP TRIGGER IF EXISTS trg_search_logs_last_active  ON search_logs;

CREATE TRIGGER trg_favorites_last_active
    AFTER INSERT ON favorites
    FOR EACH ROW EXECUTE FUNCTION update_last_active();

CREATE TRIGGER trg_mood_history_last_active
    AFTER INSERT ON mood_history
    FOR EACH ROW EXECUTE FUNCTION update_last_active();

CREATE TRIGGER trg_search_logs_last_active
    AFTER INSERT ON search_logs
    FOR EACH ROW EXECUTE FUNCTION update_last_active();
