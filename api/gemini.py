from http.server import BaseHTTPRequestHandler
import json
import urllib.request
import urllib.parse

TMDB_API_KEY = "bb597d85fbd9044ebd48b8a454a8c972"
TMDB_BASE    = "https://api.themoviedb.org/3"

MOOD_GENRES = {
    "happy":     "35,10751,16",
    "sad":       "18,10749",
    "romantic":  "10749,18",
    "thriller":  "53,9648,80",
    "scifi":     "878,14,12",
    "action":    "28,12",
    "horror":    "27,53",
    "animation": "16,10751,35",
}

def tmdb_get(path, extra_params=""):
    url = f"{TMDB_BASE}{path}?api_key={TMDB_API_KEY}&language=en-US{extra_params}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode())

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)

            req_type = params.get("type",  ["tmdb_mood"])[0]
            mood     = params.get("mood",  ["happy"])[0].lower()
            page     = params.get("page",  ["1"])[0]
            query    = params.get("query", [""])[0]
            movie_id = params.get("id",    [""])[0]

            if req_type == "tmdb_mood":
                genres = MOOD_GENRES.get(mood, "35,10751,16")
                data = tmdb_get("/discover/movie",
                    f"&with_genres={genres}&sort_by=popularity.desc&page={page}&vote_count.gte=50")
                result = data

            elif req_type == "tmdb_top":
                genres = MOOD_GENRES.get(mood, "35,10751,16")
                data = tmdb_get("/discover/movie",
                    f"&with_genres={genres}&sort_by=vote_average.desc&page={page}&vote_count.gte=200")
                result = data

            elif req_type == "tmdb_trending":
                data = tmdb_get("/trending/movie/week")
                result = data

            elif req_type == "tmdb_search":
                q = urllib.parse.quote(query)
                data = tmdb_get("/search/movie",
                    f"&query={q}&page={page}")
                result = data

            elif req_type == "tmdb_detail":
                data = tmdb_get(f"/movie/{movie_id}", "&append_to_response=credits")
                result = data

            else:
                result = {"results": []}

            # Always return { results: [...] } shape (detail returns a plain object, that's fine)
            if "results" not in result and req_type != "tmdb_detail":
                result = {"results": []}

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
