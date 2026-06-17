import json
import math
from http.server import BaseHTTPRequestHandler

# ── Mood vocabulary ────────────────────────────────────────────────────────────
MOODS = ["happy", "sad", "excited", "anxious", "romantic", "angry", "bored", "nostalgic"]
MOOD_IDX = {m: i for i, m in enumerate(MOODS)}
N_MOODS = len(MOODS)

# ── Pure-Python math helpers ───────────────────────────────────────────────────
def sigmoid(x):
    x = max(-30.0, min(30.0, x))          # clamp to avoid overflow
    return 1.0 / (1.0 + math.exp(-x))

def tanh(x):
    x = max(-30.0, min(30.0, x))
    return math.tanh(x)

def softmax(vec):
    m = max(vec)
    exps = [math.exp(v - m) for v in vec]
    s = sum(exps)
    return [e / s for e in exps]

def dot(a, b):
    return sum(x * y for x, y in zip(a, b))

def mat_vec(M, v):
    """Matrix (list-of-rows) × vector."""
    return [dot(row, v) for row in M]

def vec_add(a, b):
    return [x + y for x, y in zip(a, b)]

def vec_mul(a, b):
    return [x * y for x, y in zip(a, b)]

def vec_scalar(a, s):
    return [x * s for x in a]

# ── One-hot encoding ───────────────────────────────────────────────────────────
def one_hot(idx, size=N_MOODS):
    v = [0.0] * size
    v[idx] = 1.0
    return v

# ── Hardcoded LSTM weights (simulating trained weights) ────────────────────────
# Hidden size = 8  (same as vocabulary size for simplicity)
# Each gate has: Wh (8×8), Wx (8×8), b (8,)
# Weights are crafted so emotionally similar moods cluster together:
#   happy ↔ excited ↔ romantic  (positive valence)
#   sad ↔ nostalgic ↔ bored     (low arousal)
#   anxious ↔ angry              (high negative)

H = N_MOODS  # hidden dim

# Transition affinity matrix — encodes which mood follows which naturally
# Rows = current mood index, Cols = next mood index
AFFINITY = [
    # hpy  sad  exc  anx  rom  ang  bor  nos
    [0.1, 0.0, 0.4, 0.1, 0.3, 0.0, 0.0, 0.1],  # happy   → excited, romantic
    [0.0, 0.1, 0.0, 0.1, 0.1, 0.1, 0.2, 0.4],  # sad     → nostalgic, bored
    [0.3, 0.0, 0.1, 0.2, 0.2, 0.1, 0.0, 0.1],  # excited → happy, anxious
    [0.1, 0.2, 0.1, 0.1, 0.0, 0.3, 0.1, 0.1],  # anxious → angry, sad
    [0.3, 0.1, 0.1, 0.0, 0.1, 0.0, 0.1, 0.3],  # romantic→ happy, nostalgic
    [0.0, 0.2, 0.2, 0.3, 0.0, 0.1, 0.1, 0.1],  # angry   → anxious, excited
    [0.1, 0.3, 0.0, 0.1, 0.1, 0.0, 0.1, 0.3],  # bored   → sad, nostalgic
    [0.2, 0.2, 0.0, 0.0, 0.3, 0.0, 0.2, 0.1],  # nostalgic→ romantic, happy
]

def _make_gate_weights(scale, shift=0.0):
    """Generate deterministic weight matrices from the affinity table."""
    Wx = [[AFFINITY[j][i] * scale + shift for j in range(H)] for i in range(H)]
    Wh = [[(0.1 if i == j else 0.05) * scale for j in range(H)] for i in range(H)]
    b  = [shift * 0.1] * H
    return Wx, Wh, b

# Gate weight sets
Wx_f, Wh_f, b_f = _make_gate_weights(1.5, 0.5)   # forget gate — stay open
Wx_i, Wh_i, b_i = _make_gate_weights(1.2, 0.0)   # input gate
Wx_c, Wh_c, b_c = _make_gate_weights(1.0, 0.0)   # cell candidate
Wx_o, Wh_o, b_o = _make_gate_weights(1.0, 0.2)   # output gate

# Output projection W (H → N_MOODS) — identity-like so hidden ≈ mood probs
W_out = [[1.0 if i == j else 0.0 for j in range(H)] for i in range(N_MOODS)]
b_out = [0.0] * N_MOODS

# ── LSTM cell (single step) ────────────────────────────────────────────────────
def lstm_step(x, h_prev, c_prev):
    """
    x       : input vector  (N_MOODS,)
    h_prev  : hidden state  (H,)
    c_prev  : cell state    (H,)
    Returns : h_next, c_next, gate_values dict
    """
    # forget gate
    f = [sigmoid(v) for v in vec_add(vec_add(mat_vec(Wx_f, x), mat_vec(Wh_f, h_prev)), b_f)]
    # input gate
    i = [sigmoid(v) for v in vec_add(vec_add(mat_vec(Wx_i, x), mat_vec(Wh_i, h_prev)), b_i)]
    # cell candidate
    c_tilde = [tanh(v) for v in vec_add(vec_add(mat_vec(Wx_c, x), mat_vec(Wh_c, h_prev)), b_c)]
    # cell state
    c_next = vec_add(vec_mul(f, c_prev), vec_mul(i, c_tilde))
    # output gate
    o = [sigmoid(v) for v in vec_add(vec_add(mat_vec(Wx_o, x), mat_vec(Wh_o, h_prev)), b_o)]
    # hidden state
    h_next = vec_mul(o, [tanh(v) for v in c_next])

    return h_next, c_next, {"forget": f, "input": i, "output": o, "cell": c_next}

# ── Full sequence processing ───────────────────────────────────────────────────
def run_lstm(mood_history):
    h = [0.0] * H
    c = [0.0] * H
    step_info = []

    for mood in mood_history:
        idx = MOOD_IDX[mood]
        x = one_hot(idx)
        h, c, gates = lstm_step(x, h, c)

        # Project hidden → logits → probs
        logits = vec_add(mat_vec(W_out, h), b_out)
        probs  = softmax(logits)

        top_idx   = probs.index(max(probs))
        step_info.append({
            "input_mood": mood,
            "top_prediction": MOODS[top_idx],
            "confidence": round(max(probs), 4),
            "forget_gate_avg": round(sum(gates["forget"]) / H, 4),
            "input_gate_avg":  round(sum(gates["input"])  / H, 4),
            "output_gate_avg": round(sum(gates["output"]) / H, 4),
        })

    # Final projection after full sequence
    logits = vec_add(mat_vec(W_out, h), b_out)
    probs  = softmax(logits)

    pred_idx    = probs.index(max(probs))
    predicted   = MOODS[pred_idx]
    confidence  = round(probs[pred_idx], 4)
    mood_probs  = {MOODS[i]: round(probs[i], 4) for i in range(N_MOODS)}

    return predicted, confidence, step_info, mood_probs

# ── Vercel handler ─────────────────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body   = self.rfile.read(length)
            data   = json.loads(body)

            mood_history = data.get("mood_history", [])

            # Validate
            if not isinstance(mood_history, list) or len(mood_history) == 0:
                self._error(400, "mood_history must be a non-empty list")
                return

            invalid = [m for m in mood_history if m not in MOOD_IDX]
            if invalid:
                self._error(400, f"Unknown moods: {invalid}. Valid: {MOODS}")
                return

            predicted, confidence, step_info, mood_probs = run_lstm(mood_history)

            self._json(200, {
                "predicted_mood":    predicted,
                "confidence":        confidence,
                "sequence_analysis": step_info,
                "all_mood_probs":    mood_probs,
                "input_sequence":    mood_history,
                "sequence_length":   len(mood_history),
            })

        except json.JSONDecodeError:
            self._error(400, "Invalid JSON body")
        except Exception as e:
            self._error(500, str(e))

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, msg):
        self._json(status, {"error": msg})

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
