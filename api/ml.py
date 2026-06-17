from http.server import BaseHTTPRequestHandler
import json
import math
import re

# ── SENTIMENT DATA ────────────────────────────────────────────────────────────

SENTIMENT_WORDS = {
    "positive": [
        "happy", "joy", "joyful", "love", "wonderful", "amazing", "great", "fantastic",
        "excited", "fun", "laugh", "cheerful", "delightful", "upbeat", "bright", "funny",
        "romantic", "beautiful", "sweet", "adorable", "charming", "warm", "light",
        "adventure", "thrilling", "epic", "heroic", "brave", "strong", "powerful",
        "curious", "wonder", "magic", "dream", "hope", "inspire", "uplift",
        "energetic", "pumped", "bold", "fearless", "daring", "confident",
        "crush", "affection", "tender", "longing", "nostalgic",
        "chill", "relaxed", "cozy", "lazy", "mellow", "calm",
        "nerdy", "thoughtful", "philosophical", "intellectual", "pensive",
    ],
    "negative": [
        "sad", "cry", "depressed", "miserable", "grief", "loss", "sorrow", "lonely",
        "dark", "fear", "scared", "terrified", "horror", "nightmare", "death", "dead",
        "angry", "rage", "violent", "brutal", "blood", "kill", "murder", "monster",
        "anxiety", "stress", "tense", "suspense", "danger", "threat", "evil", "sinister",
        "melancholy", "heartbreak", "tragedy", "despair", "pain", "suffer",
        "bored", "dull", "restless", "anxious", "nervous", "worried", "panicked",
        "alone", "isolated", "empty", "hollow", "numb", "broken",
    ],
}

# Maps each mood to trigger keywords + sentiment bias
MOOD_SIGNALS = {
    "happy": {
        "words": ["happy", "joy", "fun", "laugh", "cheerful", "upbeat", "comedy", "light",
                  "silly", "playful", "smile", "goofy", "hilarious", "giddy", "elated",
                  "carefree", "bubbly", "jolly", "humor"],
        "bias": 0.4,
    },
    "sad": {
        "words": ["sad", "cry", "grief", "loss", "sorrow", "lonely", "melancholy",
                  "heartbreak", "tragedy", "tears", "depressed", "miserable", "heartbroken",
                  "broken", "hopeless", "despair", "mourn", "empty", "alone", "isolated",
                  "abandoned", "unloved", "hurt", "devastated", "gloomy", "blue"],
        "bias": -0.3,
    },
    "romantic": {
        "words": ["romantic", "love", "romance", "passion", "sweet", "kiss", "couple",
                  "valentine", "adorable", "charming", "crush", "affection", "tender",
                  "date", "flirt", "intimacy", "longing", "soulmate", "butterflies",
                  "beloved", "infatuated", "attracted", "devoted", "loving", "heartfelt"],
        "bias": 0.3,
    },
    "excited": {
        "words": ["excited", "pumped", "thrilled", "energetic", "hyped", "adrenaline",
                  "bold", "fearless", "daring", "epic", "intense", "rush", "wild",
                  "extreme", "warrior", "champion", "combat", "powerful", "unstoppable",
                  "driven", "motivated", "fired"],
        "bias": 0.1,
    },
    "anxious": {
        "words": ["anxious", "nervous", "worried", "stress", "panic", "fear", "scared",
                  "tense", "uneasy", "dread", "overwhelmed", "paranoid", "suspense",
                  "danger", "threat", "sinister", "conspiracy", "mystery", "thriller",
                  "gripping", "edgy"],
        "bias": -0.2,
    },
    "angry": {
        "words": ["angry", "furious", "mad", "rage", "frustrated", "annoyed", "irritated",
                  "hate", "upset", "outraged", "livid", "bitter", "violent", "brutal",
                  "blood", "kill", "murder", "fight", "battle", "war"],
        "bias": -0.15,
    },
    "bored": {
        "words": ["bored", "lazy", "nothing", "idle", "dull", "tired", "sleepy", "meh",
                  "whatever", "chill", "relax", "slow", "quiet", "calm", "mellow",
                  "lighthearted", "whimsical", "cartoon", "animated", "kids", "family",
                  "cute", "colorful", "childhood", "comfort"],
        "bias": 0.3,
    },
    "nostalgic": {
        "words": ["nostalgic", "memories", "childhood", "old", "remember", "miss", "past",
                  "classic", "throwback", "vintage", "remind", "used"],
        "bias": 0.0,
    },
}

# ── CONTENT-BASED FILTERING DATA ─────────────────────────────────────────────

# All TMDb genre IDs used as feature-vector dimensions (19D)
GENRE_IDS = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37]

MOOD_GENRE_MAP = {
    "happy":     [35, 10751, 16],
    "sad":       [18, 10749],
    "romantic":  [10749, 18, 35],
    "excited":   [28, 12, 53],
    "anxious":   [53, 9648, 80],
    "angry":     [28, 80, 53],
    "bored":     [16, 10751, 35],
    "nostalgic": [18, 36, 10751],
}

# 8D mood centroids for K-Means (index = mood order)
MOOD_NAMES = ["happy", "sad", "romantic", "excited", "anxious", "angry", "bored", "nostalgic"]

MOOD_CENTROIDS = [
    [0.9, 0.0, 0.0, 0.0, 0.0, 0.0, 0.8, 0.0],  # happy
    [0.0, 0.9, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5],  # sad
    [0.0, 0.3, 0.9, 0.0, 0.0, 0.0, 0.0, 0.0],  # romantic
    [0.0, 0.0, 0.0, 0.9, 0.3, 0.3, 0.0, 0.0],  # excited
    [0.0, 0.0, 0.0, 0.2, 0.9, 0.3, 0.0, 0.0],  # anxious
    [0.0, 0.0, 0.0, 0.5, 0.2, 0.9, 0.0, 0.0],  # angry
    [0.6, 0.0, 0.0, 0.0, 0.0, 0.0, 0.9, 0.0],  # bored
    [0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.9],  # nostalgic
]

# Maps TMDb genre ID → which 8D dimension it contributes to
GENRE_TO_DIM = {
    35: 0, 10751: 0, 16: 0,       # comedy/family/animation → happy/bored
    18: 1, 36: 1,                  # drama/history → sad/nostalgic
    10749: 2,                      # romance → romantic
    28: 3, 12: 3,                  # action/adventure → excited
    53: 4, 9648: 4, 27: 4,         # thriller/mystery/horror → anxious
    80: 5,                         # crime → angry
    14: 6, 878: 6,                 # fantasy/sci-fi → bored
    10752: 3, 37: 7,               # war → excited, western → nostalgic
}


# ── MATH HELPERS ─────────────────────────────────────────────────────────────

def dot(a: list, b: list) -> float:
    return sum(x * y for x, y in zip(a, b))

def norm(v: list) -> float:
    return math.sqrt(sum(x * x for x in v)) or 1e-9

def cosine_similarity(a: list, b: list) -> float:
    return dot(a, b) / (norm(a) * norm(b))

def euclidean(a: list, b: list) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))

def softmax(scores: list) -> list:
    e = [math.exp(max(-500, min(500, s))) for s in scores]
    total = sum(e) or 1e-9
    return [v / total for v in e]

def genre_vector_19d(genre_ids: list) -> list:
    """Convert genre_ids to 19D binary vector (one dimension per GENRE_IDS entry)."""
    return [1 if g in genre_ids else 0 for g in GENRE_IDS]

def genre_vector_8d(genre_ids: list) -> list:
    """Convert genre_ids to 8D mood vector, normalized."""
    vec = [0.0] * 8
    for gid in genre_ids:
        dim = GENRE_TO_DIM.get(gid)
        if dim is not None:
            vec[dim] += 1.0
    n = norm(vec)
    return [x / n for x in vec]


# ── 1. SENTIMENT ANALYSIS ────────────────────────────────────────────────────

def analyze_sentiment(text: str) -> dict:
    tokens = re.findall(r'\b[a-z]+\b', text.lower())

    # Positive / negative word counts
    pos_words = [t for t in tokens if t in SENTIMENT_WORDS["positive"]]
    neg_words = [t for t in tokens if t in SENTIMENT_WORDS["negative"]]
    pos, neg = len(set(pos_words)), len(set(neg_words))
    total_sent = (pos + neg) or 1
    sentiment_score = (pos - neg) / total_sent   # -1 … +1

    # Keyword hits per mood
    raw_scores = {}
    matched_per_mood = {}
    for mood, cfg in MOOD_SIGNALS.items():
        hits = [t for t in tokens if t in cfg["words"]]
        raw_scores[mood] = len(hits) + sentiment_score * cfg["bias"] * 2
        matched_per_mood[mood] = list(dict.fromkeys(hits))  # deduplicated, ordered

    # Softmax confidence
    score_list = [raw_scores[m] for m in MOOD_NAMES if m in raw_scores]
    # Include any extra moods not in MOOD_NAMES
    for m in raw_scores:
        if m not in MOOD_NAMES:
            score_list.append(raw_scores[m])
    all_moods_ordered = [m for m in MOOD_NAMES if m in raw_scores] + \
                        [m for m in raw_scores if m not in MOOD_NAMES]
    sm = softmax(score_list)
    soft_scores = {m: round(sm[i] * 100, 1) for i, m in enumerate(all_moods_ordered)}

    top_mood = max(soft_scores, key=soft_scores.get)
    confidence = round(soft_scores[top_mood])

    # Boost confidence for strong keyword hits
    hit_boost = min(25, len(matched_per_mood.get(top_mood, [])) * 5)
    confidence = min(99, max(10, confidence + hit_boost))

    keywords_found = list(dict.fromkeys(
        pos_words + neg_words + matched_per_mood.get(top_mood, [])
    ))[:10]

    sentiment_label = "positive" if sentiment_score > 0.1 else \
                      "negative" if sentiment_score < -0.1 else "neutral"

    return {
        "mood":          top_mood,
        "confidence":    confidence,
        "all_scores":    soft_scores,
        "keywords_found": keywords_found,
        "sentiment":     sentiment_label,
    }


# ── 2. CONTENT-BASED FILTERING (Cosine Similarity) ──────────────────────────

def content_based_filter(movies: list, mood: str) -> list:
    """Rank movies by cosine similarity of their 8D genre vector to the mood vector."""
    mood_vec = MOOD_CENTROIDS[MOOD_NAMES.index(mood)] if mood in MOOD_NAMES else MOOD_CENTROIDS[0]

    for movie in movies:
        genre_ids = movie.get("genre_ids", [])
        movie_vec = genre_vector_8d(genre_ids)
        movie["_cosine"] = cosine_similarity(mood_vec, movie_vec)

    return sorted(movies, key=lambda m: m.get("_cosine", 0), reverse=True)


# ── 3. K-MEANS CLUSTERING ────────────────────────────────────────────────────

def kmeans_cluster(movies: list, mood: str, k: int = 8, iterations: int = 10) -> list:
    """
    8-cluster K-Means over movie genre vectors (8D).
    Returns only movies assigned to the target mood cluster.
    Falls back to cosine-ranked full list if cluster is empty.
    """
    if not movies:
        return movies

    # Initialise centroids from mood definitions
    centroids = [row[:] for row in MOOD_CENTROIDS]  # deep copy

    for _ in range(iterations):
        # Assignment step
        for movie in movies:
            vec = genre_vector_8d(movie.get("genre_ids", []))
            dists = [euclidean(vec, c) for c in centroids]
            movie["_cluster"] = dists.index(min(dists))

        # Update step — recompute centroids from assigned movies
        new_centroids = []
        for k_idx in range(k):
            members = [genre_vector_8d(m.get("genre_ids", [])) for m in movies if m.get("_cluster") == k_idx]
            if members:
                new_centroids.append([
                    sum(v[d] for v in members) / len(members)
                    for d in range(8)
                ])
            else:
                new_centroids.append(centroids[k_idx])
        centroids = new_centroids

    target = MOOD_NAMES.index(mood) if mood in MOOD_NAMES else 0
    cluster_movies = [m for m in movies if m.get("_cluster") == target]

    # Fall back to full ranked list if cluster too small
    return cluster_movies if len(cluster_movies) >= 3 else movies


# ── 4 & 5. MATCH SCORING + CONFIDENCE BADGE ─────────────────────────────────

def compute_match_score(movie: dict) -> dict:
    """
    0-100 match score combining cosine similarity + vote_average bonus.
    Badge: Perfect (80-100), Good (60-79), Explore (<60).
    """
    cosine     = movie.get("_cosine", 0)
    vote       = movie.get("vote_average") or 0
    vote_bonus = 10 if vote > 7.5 else 5 if vote > 6.0 else 0
    count_bonus = 5 if (movie.get("vote_count") or 0) > 500 else 0

    score = min(100, round(cosine * 85) + vote_bonus + count_bonus)

    badge = "Perfect Match" if score >= 80 else \
            "Good Match"    if score >= 60 else \
            "Explore"

    return {"ml_score": score, "badge": badge}


def format_movie_ml(movie: dict) -> dict:
    """Return clean movie dict with ML fields, stripping internal keys."""
    m = compute_match_score(movie)
    return {
        "id":           movie.get("id"),
        "title":        movie.get("title") or movie.get("original_title", ""),
        "overview":     movie.get("overview", ""),
        "poster_path":  movie.get("poster_path"),
        "genre_ids":    movie.get("genre_ids", []),
        "vote_average": movie.get("vote_average"),
        "vote_count":   movie.get("vote_count"),
        "release_date": movie.get("release_date", ""),
        "ml_score":     m["ml_score"],
        "badge":        m["badge"],
        "cosine":       round(movie.get("_cosine", 0), 4),
        "cluster":      movie.get("_cluster"),
    }


# ── HANDLER ───────────────────────────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        pass  # suppress default logs

    def send_json(self, status: int, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length)) if length else {}

            type_   = body.get("type", "ml_sentiment")
            payload = body.get("payload", {})

            # ── SENTIMENT ANALYSIS ────────────────────────────────
            if type_ == "ml_sentiment":
                text = (payload.get("text") or body.get("text") or "").strip()
                if not text:
                    return self.send_json(400, {"error": "text is required"})
                return self.send_json(200, analyze_sentiment(text))

            # ── FULL ML PIPELINE ──────────────────────────────────
            # POST { "text": "...", "movies": [...] }
            if type_ == "ml_pipeline":
                text   = (payload.get("text") or body.get("text") or "").strip()
                movies = payload.get("movies") or body.get("movies") or []
                if not text:
                    return self.send_json(400, {"error": "text is required"})

                # Step 1 — Sentiment
                sentiment = analyze_sentiment(text)
                mood      = sentiment["mood"]

                # Step 2 — Content-based filtering (cosine ranking)
                ranked = content_based_filter(movies, mood)

                # Step 3 — K-Means clustering
                clustered = kmeans_cluster(ranked, mood)

                # Step 4+5 — Match score + badge
                result_movies = [format_movie_ml(m) for m in clustered[:12]]

                return self.send_json(200, {
                    "mood":           mood,
                    "confidence":     sentiment["confidence"],
                    "all_scores":     sentiment["all_scores"],
                    "keywords_found": sentiment["keywords_found"],
                    "sentiment":      sentiment["sentiment"],
                    "movies":         result_movies,
                    "count":          len(result_movies),
                })

            # ── CONTENT-BASED FILTERING ONLY ─────────────────────
            if type_ == "ml_recommend":
                movies = payload.get("movies", [])
                mood   = payload.get("mood", "happy")
                ranked = content_based_filter(movies, mood)
                return self.send_json(200, {
                    "movies": [format_movie_ml(m) for m in ranked]
                })

            # ── K-MEANS CLUSTERING ONLY ───────────────────────────
            if type_ == "ml_cluster":
                movies = payload.get("movies", [])
                mood   = payload.get("mood", "happy")
                if not isinstance(movies, list):
                    return self.send_json(400, {"error": "movies array required"})
                ranked    = content_based_filter(movies, mood)
                clustered = kmeans_cluster(ranked, mood)
                return self.send_json(200, {
                    "movies": [format_movie_ml(m) for m in clustered]
                })

            return self.send_json(400, {"error": f"Unknown type '{type_}'. Use ml_sentiment, ml_pipeline, ml_recommend, or ml_cluster."})

        except Exception as e:
            self.send_json(500, {"error": str(e)})
