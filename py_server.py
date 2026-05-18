import json
import os
import secrets
import hashlib
import hmac
import threading
import time
import traceback
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
import ssl


ROOT_DIR = Path(__file__).resolve().parent
CONTACTS_FILE = ROOT_DIR / "contacts.json"
CONTACTS_LOCK = threading.Lock()

USERS_FILE = ROOT_DIR / "users.json"
USERS_LOCK = threading.Lock()

SMS_LOG_FILE = ROOT_DIR / "sms_logs.jsonl"
SMS_LOG_LOCK = threading.Lock()

COOKIE_NAME = "bh_sid"
SESSION_TTL_SECONDS = int(os.environ.get("SESSION_TTL_SECONDS", "28800"))  # 8 hours
FORCE_SECURE_COOKIES = os.environ.get("FORCE_SECURE_COOKIES", "").strip().lower() in ("1", "true", "yes")

DATA_BACKEND = os.environ.get("DATA_BACKEND", "file").strip().lower()
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
_PG_LOCAL = threading.local()

def _pg_enabled():
    return DATA_BACKEND in ("postgres", "pg")

def _pg_connect():
    if not DATABASE_URL:
        raise RuntimeError("DATA_BACKEND=postgres requires DATABASE_URL")
    try:
        import psycopg2  # type: ignore
    except Exception as e:
        raise RuntimeError("Postgres backend requires psycopg2. Install: apt install python3-psycopg2 (or pip install psycopg2-binary)") from e
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    return conn

def _pg_conn():
    conn = getattr(_PG_LOCAL, "conn", None)
    if conn is not None:
        return conn
    conn = _pg_connect()
    _PG_LOCAL.conn = conn
    return conn

def _pg_init_schema():
    if not _pg_enabled():
        return
    conn = _pg_conn()
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS bh_kv ("
            " key text PRIMARY KEY,"
            " value jsonb NOT NULL,"
            " updated_at timestamptz NOT NULL DEFAULT now()"
            ")"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS bh_sms_logs ("
            " id bigserial PRIMARY KEY,"
            " created_at timestamptz NOT NULL DEFAULT now(),"
            " entry jsonb NOT NULL"
            ")"
        )

def _pg_kv_get(key: str):
    conn = _pg_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT value FROM bh_kv WHERE key = %s", (key,))
        row = cur.fetchone()
    if not row:
        return None
    return row[0]

def _pg_kv_set(key: str, value):
    conn = _pg_conn()
    payload = json.dumps(value, ensure_ascii=False)
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO bh_kv(key, value, updated_at) VALUES (%s, %s::jsonb, now()) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
            (key, payload),
        )

DEFAULT_SPECIAL_DAY_SENDER_IDS = []

DEFAULT_ADMIN_TEMPLATES = []

SUBSCRIPTION_PLANS = [
    {"ghs": 1, "sms": 25},
    {"ghs": 3, "sms": 50},
    {"ghs": 7, "sms": 100},
    {"ghs": 15, "sms": 250},
    {"ghs": 30, "sms": 500},
    {"ghs": 60, "sms": 700},
]
PAYSTACK_FIXED_EMAIL = "nuhuibntahir@gmail.com"

SESSIONS = {}
OTP_STORE = {}
OTP_TTL_SECONDS = 600
OTP_MAX_ATTEMPTS = 5
OTP_SENDER_ID = "AyiSun SMS"
OTP_RATE = {}
OTP_RATE_WINDOW_SECONDS = 600
OTP_RATE_LIMIT_PER_PHONE = 3
OTP_RATE_LIMIT_PER_IP = 10
NEW_ACCOUNT_FREE_SMS_CREDITS = 20
DAILY_FREE_TRIAL_SMS = 10

def utc_today_ymd():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")

def trial_daily_reset_if_needed(user: dict):
    if not isinstance(user, dict):
        return False
    if bool(user.get("is_admin")):
        return False
    if bool(user.get("is_free")):
        return False
    if bool(user.get("has_purchased")):
        return False
    today = utc_today_ymd()
    prev = str(user.get("trial_daily_ymd") or "")
    if prev == today:
        return False
    user["trial_daily_ymd"] = today
    user["trial_daily_used"] = 0
    return True

def trial_daily_remaining(user: dict):
    used = int(user.get("trial_daily_used") or 0) if isinstance(user, dict) else 0
    return max(0, int(DAILY_FREE_TRIAL_SMS) - used)

def _is_valid_otp(code: str):
    s = str(code or "").strip()
    return len(s) == 6 and s.isdigit()

def _new_otp_code():
    return f"{secrets.randbelow(1_000_000):06d}"

def _otp_key(phone: str, purpose: str):
    return f"{purpose}:{phone}"

def _otp_hash(code: str):
    return hashlib.sha256(str(code).encode("utf-8")).hexdigest()

def _send_otp_sms(phone: str, text: str):
    api_key = os.environ.get("ARKESEL_API_KEY")
    if not api_key:
        return {"ok": False, "error": "Missing ARKESEL_API_KEY on the server"}
    params = {
        "action": "send-sms",
        "api_key": api_key,
        "to": phone,
        "from": OTP_SENDER_ID,
        "sms": text,
    }
    url = "https://sms.arkesel.com/sms/api?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw
        return {"ok": True, "response": parsed}
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return {"ok": False, "error": f"HTTPError {getattr(e, 'code', '')} {getattr(e, 'reason', '')}", "detail": body[:800]}
    except Exception as e:
        return {"ok": False, "error": repr(e)}

def _rate_limit_allow(key: str, limit: int, window_seconds: int):
    now = utc_now_ts()
    rec = OTP_RATE.get(key)
    if not isinstance(rec, dict):
        rec = {"count": 0, "reset_at": now + int(window_seconds)}
    reset_at = int(rec.get("reset_at") or 0)
    if reset_at <= now:
        rec = {"count": 0, "reset_at": now + int(window_seconds)}
    rec["count"] = int(rec.get("count") or 0) + 1
    OTP_RATE[key] = rec
    return rec["count"] <= int(limit), max(0, int(rec.get("reset_at") or 0) - now)

def _create_session_and_response(handler, username: str, user: dict):
    sender_ids = list(user.get("sender_ids") or []) if isinstance(user, dict) else []
    approved = [s for s in sender_ids if isinstance(s, dict) and s.get("status") == "approved"]
    display_brand = (approved[0].get("name") if approved else "") or ""
    sms_credits = int(user.get("sms_credits") or 0) if isinstance(user, dict) else 0
    is_free = bool(user.get("is_free")) if isinstance(user, dict) else False
    sid = secrets.token_urlsafe(32)
    expires_at = utc_now_ts() + SESSION_TTL_SECONDS
    SESSIONS[sid] = {
        "username": username,
        "is_admin": bool(user.get("is_admin")) if isinstance(user, dict) else False,
        "expires_at": expires_at,
    }
    return handler.send_json(
        200,
        {
            "status": "success",
            "logged_in": True,
            "username": username,
            "name": (user.get("name") if isinstance(user, dict) else "") or "",
            "is_free": is_free,
            "brandname": display_brand,
            "is_admin": bool(user.get("is_admin")) if isinstance(user, dict) else False,
            "sms_credits": sms_credits,
            "sender_ids": [
                {"name": s.get("name"), "status": s.get("status"), "created_at": s.get("created_at"), "approved_at": s.get("approved_at")}
                for s in sender_ids
                if isinstance(s, dict)
            ],
            "special_day_sender_ids": list(SPECIAL_DAY_SENDER_IDS),
        },
        headers=[("Set-Cookie", handler.build_cookie_header(sid, SESSION_TTL_SECONDS))],
    )

def safe_print(msg: str):
    try:
        print(msg, flush=True)
    except Exception:
        return

def utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


def utc_now_ts():
    return int(time.time())

def normalize_username(username: str):
    return username.strip().lower()


def normalize_brandname(brandname: str):
    return " ".join(brandname.strip().split())

def normalize_template_text(text: str):
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [(" ".join(line.strip().split())) for line in text.split("\n")]
    cleaned = "\n".join(lines).strip()
    return cleaned


def normalize_ads_lines(text: str):
    cleaned = normalize_template_text(text)
    if not cleaned:
        return []
    out = []
    seen = set()
    for line in cleaned.split("\n"):
        line = " ".join(str(line or "").strip().split())
        if not line:
            continue
        if len(line) > 220:
            line = line[:220].rstrip()
        k = line.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(line)
        if len(out) >= 50:
            break
    return out


def template_fingerprint(text: str):
    norm = normalize_template_text(text)
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def is_valid_username(username: str):
    if not username:
        return False
    if len(username) < 3 or len(username) > 32:
        return False
    return username.replace("_", "").replace("-", "").isalnum()


def is_valid_brandname(brandname: str):
    if not brandname:
        return False
    if len(brandname) < 3 or len(brandname) > 15:
        return False
    for ch in brandname:
        if ch.isalnum() or ch == " ":
            continue
        return False
    return True


def normalize_sender_id(name: str):
    return " ".join((name or "").strip().split())


def is_valid_sender_id(name: str):
    name = normalize_sender_id(name)
    if not name:
        return False
    if len(name) > 11:
        return False
    for ch in name:
        if ch.isalnum() or ch == " ":
            continue
        return False
    return True


def sender_id_key(name: str):
    return normalize_sender_id(name).lower()


def normalize_template_id(template_id: str):
    return " ".join(str(template_id or "").strip().split())


def is_valid_template_id(template_id: str):
    tid = normalize_template_id(template_id)
    if not tid:
        return False
    if len(tid) > 32:
        return False
    for ch in tid:
        if ch.isalnum() or ch in (" ", "-", "_"):
            continue
        return False
    return True


def normalize_phone_number(raw: str):
    s = (raw or "").strip()
    if not s:
        return ""
    for ch in (" ", "-", "(", ")", "\t"):
        s = s.replace(ch, "")
    if s.startswith("+"):
        s = s[1:]
    if s.startswith("0") and len(s) == 10 and s.isdigit():
        s = "233" + s[1:]
    return s


ADMIN_PHONE = normalize_phone_number("0243951661")


def hash_password(password: str, salt_hex: Optional[str] = None):
    if salt_hex:
        salt = bytes.fromhex(salt_hex)
    else:
        salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return {"salt": salt.hex(), "hash": dk.hex()}


def verify_password(password: str, password_hash_hex: str, salt_hex: str):
    calc = hash_password(password, salt_hex=salt_hex)["hash"]
    return hmac.compare_digest(calc, password_hash_hex)


def load_users_from_disk():
    try:
        if _pg_enabled():
            _pg_init_schema()
            data = _pg_kv_get("store")
            if isinstance(data, dict):
                if not isinstance(data.get("version"), int):
                    data["version"] = 1
                if not isinstance(data.get("users"), dict):
                    data["users"] = {}
                if not isinstance(data.get("special_day_sender_ids"), list):
                    data["special_day_sender_ids"] = []
                if not isinstance(data.get("admin_templates"), list):
                    data["admin_templates"] = []
                return data
            return {"version": 1, "users": {}, "special_day_sender_ids": [], "admin_templates": []}
        if not USERS_FILE.exists():
            return {"version": 1, "users": {}, "special_day_sender_ids": [], "admin_templates": []}
        raw = USERS_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict):
            return {"version": 1, "users": {}, "special_day_sender_ids": [], "admin_templates": []}
        if not isinstance(data.get("version"), int):
            data["version"] = 1
        users = data.get("users")
        if not isinstance(users, dict):
            data["users"] = {}
        special_days = data.get("special_day_sender_ids")
        if not isinstance(special_days, list):
            data["special_day_sender_ids"] = []
        admin_templates = data.get("admin_templates")
        if not isinstance(admin_templates, list):
            data["admin_templates"] = []
        return data
    except Exception:
        return {"version": 1, "users": {}, "special_day_sender_ids": [], "admin_templates": []}


def save_users_to_disk(store: dict):
    if _pg_enabled():
        _pg_init_schema()
        _pg_kv_set("store", store)
        return
    tmp = USERS_FILE.with_suffix(".json.tmp")
    payload = json.dumps(store, ensure_ascii=False)
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(USERS_FILE)


STORE = load_users_from_disk()
USERS = STORE["users"]
SPECIAL_DAY_SENDER_IDS = STORE["special_day_sender_ids"]
ADMIN_TEMPLATES = STORE.get("admin_templates") if isinstance(STORE, dict) else []
if not isinstance(ADMIN_TEMPLATES, list):
    ADMIN_TEMPLATES = []

HOME_ADS = STORE.get("home_ads") if isinstance(STORE, dict) else None
if not isinstance(HOME_ADS, list):
    HOME_ADS = []
SPECIAL_ADS = STORE.get("special_ads") if isinstance(STORE, dict) else None
if not isinstance(SPECIAL_ADS, list):
    SPECIAL_ADS = []

def _clean_preview_message(value):
    if value is None:
        return ""
    s = str(value)
    if s.strip().lower() == "none":
        return ""
    return s

HOME_PREVIEW_MESSAGE = _clean_preview_message(STORE.get("home_preview_message") if isinstance(STORE, dict) else None)
SPECIAL_PREVIEW_MESSAGE = _clean_preview_message(STORE.get("special_preview_message") if isinstance(STORE, dict) else None)

def _clean_trusted_brands(value):
    items = value if isinstance(value, list) else []
    out = []
    seen = set()
    for it in items:
        if not isinstance(it, dict):
            continue
        name = " ".join(str(it.get("name") or "").strip().split())
        logo = str(it.get("logo") or "").strip()
        if not name:
            continue
        k = name.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append({"name": name, "logo": logo})
    return out

TRUSTED_BRANDS = _clean_trusted_brands(STORE.get("trusted_brands") if isinstance(STORE, dict) else [])
if STORE.get("trusted_brands") != TRUSTED_BRANDS:
    STORE["trusted_brands"] = TRUSTED_BRANDS
    save_users_to_disk(STORE)

_admin_templates_changed = False
_admin_seen = set()
_admin_clean = []
for _t in ADMIN_TEMPLATES:
    if not isinstance(_t, dict):
        continue
    _tid = str(_t.get("id", "")).strip()
    _txt = normalize_template_text(str(_t.get("text", "")))
    _title = " ".join(str(_t.get("title", "") or "").strip().split())
    if not _tid or not _txt:
        _admin_templates_changed = True
        continue
    _k = _tid.lower()
    if _k in _admin_seen:
        _admin_templates_changed = True
        continue
    _admin_seen.add(_k)
    if not _title:
        _title = _txt.split("\n")[0] if _txt else ""
    _admin_clean.append(
        {
            "id": _tid,
            "title": _title,
            "text": _txt,
            "created_at": str(_t.get("created_at") or "") or utc_now_iso(),
            "created_by": str(_t.get("created_by") or "") or "admin",
        }
    )
ADMIN_TEMPLATES = _admin_clean

for _d in DEFAULT_ADMIN_TEMPLATES:
    _id = str(_d.get("id", "")).strip()
    _title = " ".join(str(_d.get("title", "") or "").strip().split())
    _text = normalize_template_text(str(_d.get("text", "")))
    if not _id or not _text:
        continue
    _k = _id.lower()
    if _k in _admin_seen:
        continue
    _admin_seen.add(_k)
    if not _title:
        _title = _text.split("\n")[0] if _text else ""
    ADMIN_TEMPLATES.append({"id": _id, "title": _title, "text": _text, "created_at": utc_now_iso(), "created_by": "admin"})
    _admin_templates_changed = True

if _admin_templates_changed or STORE.get("admin_templates") != ADMIN_TEMPLATES:
    STORE["admin_templates"] = ADMIN_TEMPLATES
    save_users_to_disk(STORE)
def _sd_key(v: str):
    return " ".join(str(v or "").strip().split()).lower()

_existing = []
_seen = set()
for _v in SPECIAL_DAY_SENDER_IDS:
    _k = _sd_key(_v)
    if not _k or _k in _seen:
        continue
    _seen.add(_k)
    _existing.append(" ".join(str(_v).strip().split()))

_changed = False
for _v in DEFAULT_SPECIAL_DAY_SENDER_IDS:
    _k = _sd_key(_v)
    if not _k or _k in _seen:
        continue
    _seen.add(_k)
    _existing.append(" ".join(str(_v).strip().split()))
    _changed = True

SPECIAL_DAY_SENDER_IDS = _existing
if _changed or STORE.get("special_day_sender_ids") != SPECIAL_DAY_SENDER_IDS:
    STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
    save_users_to_disk(STORE)

if not bool(STORE.get("free_flag_migrated_v1")):
    _free_flag_changed = False
    for _uname, _u in USERS.items():
        if not isinstance(_u, dict):
            continue
        if bool(_u.get("is_admin")):
            continue
        if bool(_u.get("is_free")):
            _u["is_free"] = False
            USERS[_uname] = _u
            _free_flag_changed = True
    STORE["free_flag_migrated_v1"] = True
    if _free_flag_changed:
        STORE["users"] = USERS
    save_users_to_disk(STORE)

if not bool(STORE.get("has_purchased_migrated_v1")):
    credited_refs = STORE.get("paystack_credited_refs")
    purchased_users = set()
    if isinstance(credited_refs, dict):
        for info in credited_refs.values():
            if not isinstance(info, dict):
                continue
            uname = str(info.get("username") or "").strip()
            if uname:
                purchased_users.add(uname)

    _p_changed = False
    for _uname, _u in USERS.items():
        if not isinstance(_u, dict):
            continue
        ensure_user_defaults(_u)
        if _uname in purchased_users and not bool(_u.get("has_purchased")):
            _u["has_purchased"] = True
            USERS[_uname] = _u
            _p_changed = True

    STORE["has_purchased_migrated_v1"] = True
    if _p_changed:
        STORE["users"] = USERS
    save_users_to_disk(STORE)


def append_sms_log(entry: dict):
    try:
        if _pg_enabled():
            _pg_init_schema()
            payload = json.dumps(entry, ensure_ascii=False)
            conn = _pg_conn()
            with conn.cursor() as cur:
                cur.execute("INSERT INTO bh_sms_logs(entry) VALUES (%s::jsonb)", (payload,))
            return
        line = json.dumps(entry, ensure_ascii=False)
        with SMS_LOG_LOCK:
            with open(SMS_LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        return


def ensure_user_defaults(user: dict):
    changed = False
    if str(user.get("username") or "") == ADMIN_PHONE and not bool(user.get("is_admin")):
        user["is_admin"] = True
        changed = True
    if "disabled" not in user:
        user["disabled"] = False
        changed = True
    if "is_free" not in user:
        user["is_free"] = False
        changed = True
    if "has_purchased" not in user:
        user["has_purchased"] = False
        changed = True
    if "trial_daily_ymd" not in user:
        user["trial_daily_ymd"] = ""
        changed = True
    if "trial_daily_used" not in user:
        user["trial_daily_used"] = 0
        changed = True
    if "templates" not in user or not isinstance(user.get("templates"), list):
        user["templates"] = []
        changed = True
    if "sender_ids" not in user or not isinstance(user.get("sender_ids"), list):
        sender_ids = []
        legacy = normalize_brandname(str(user.get("brandname", "")))
        if legacy:
            sender_ids.append({"name": legacy, "status": "approved", "created_at": utc_now_iso(), "approved_at": utc_now_iso()})
        user["sender_ids"] = sender_ids
        changed = True
    if "sms_credits" not in user:
        user["sms_credits"] = 0
        changed = True
    return changed


def load_contacts():
    try:
        if _pg_enabled():
            _pg_init_schema()
            return {"version": 1, "contacts": {}}
        if not CONTACTS_FILE.exists():
            return {"version": 1, "contacts": {}}
        raw = CONTACTS_FILE.read_text(encoding="utf-8")
        if not raw.strip():
            return {"version": 1, "contacts": {}}
        data = json.loads(raw)
        if not isinstance(data, dict):
            return {"version": 1, "contacts": {}}
        contacts = data.get("contacts")
        if not isinstance(contacts, dict):
            return {"version": 1, "contacts": {}}
        return {"version": 1, "contacts": contacts}
    except Exception:
        return {"version": 1, "contacts": {}}


def save_contacts(contacts):
    if _pg_enabled():
        return
    tmp = CONTACTS_FILE.with_suffix(".json.tmp")
    payload = json.dumps({"version": 1, "contacts": contacts}, ensure_ascii=False)
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(CONTACTS_FILE)


CONTACTS = load_contacts()["contacts"]


def json_bytes(obj):
    return json.dumps(obj).encode("utf-8")


def parse_cookies(cookie_header):
    if not cookie_header:
        return {}
    cookies = {}
    parts = cookie_header.split(";")
    for part in parts:
        part = part.strip()
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        cookies[k.strip()] = urllib.parse.unquote(v.strip())
    return cookies


def guess_content_type(file_path: Path):
    ext = file_path.suffix.lower()
    if ext == ".html":
        return "text/html; charset=utf-8"
    if ext == ".css":
        return "text/css; charset=utf-8"
    if ext == ".js":
        return "text/javascript; charset=utf-8"
    if ext == ".json":
        return "application/json; charset=utf-8"
    if ext == ".txt":
        return "text/plain; charset=utf-8"
    if ext == ".xml":
        return "application/xml; charset=utf-8"
    if ext == ".png":
        return "image/png"
    if ext in (".jpg", ".jpeg"):
        return "image/jpeg"
    if ext == ".gif":
        return "image/gif"
    if ext == ".svg":
        return "image/svg+xml; charset=utf-8"
    if ext == ".ico":
        return "image/x-icon"
    return "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    server_version = "BusinessHelpyPy/1.0"
    protocol_version = "HTTP/1.1"

    def setup(self):
        safe_print(f"Handler.setup client={self.client_address!r}")
        return super().setup()

    def handle(self):
        safe_print(f"Handler.handle start client={self.client_address!r}")
        try:
            return super().handle()
        except Exception as e:
            safe_print(f"Handler.handle crash: {repr(e)} client={self.client_address!r}")
            safe_print(traceback.format_exc())
            try:
                self.close_connection = True
            except Exception:
                return

    def log_message(self, format, *args):
        try:
            msg = format % args
        except Exception:
            msg = format
        safe_print(f"{self.client_address[0] if self.client_address else '-'} - {msg}")

    def is_https_request(self):
        if FORCE_SECURE_COOKIES:
            return True
        xf_proto = (self.headers.get("X-Forwarded-Proto") or "")
        xf_proto = xf_proto.split(",")[0].strip().lower()
        if xf_proto == "https":
            return True
        return bool(getattr(self.server, "is_https", False))

    def build_cookie_header(self, sid: str, max_age: int):
        cookie = f"{COOKIE_NAME}={urllib.parse.quote(sid)}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax"
        if self.is_https_request():
            cookie += "; Secure"
        return cookie

    def build_cookie_clear_header(self):
        cookie = f"{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
        if self.is_https_request():
            cookie += "; Secure"
        return cookie

    def send_json(self, status_code, body, headers=None):
        payload = json_bytes(body)
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        if headers:
            for k, v in headers:
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def read_body_bytes(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        return self.rfile.read(length) if length > 0 else b""

    def read_json(self):
        raw = self.read_body_bytes()
        if raw is None:
            return None
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def get_session(self):
        cookies = parse_cookies(self.headers.get("Cookie"))
        sid = cookies.get(COOKIE_NAME)
        if not sid:
            return None
        session = SESSIONS.get(sid)
        if not session:
            return None
        expires_at = session.get("expires_at")
        now = utc_now_ts()
        if isinstance(expires_at, int) and expires_at <= now:
            SESSIONS.pop(sid, None)
            return None
        return session

    def require_session(self):
        session = self.get_session()
        if not session:
            self.send_json(401, {"status": "error", "message": "Not logged in"})
            return None
        username = session.get("username")
        if username:
            with USERS_LOCK:
                user = USERS.get(str(username))
            if not user:
                self.send_json(
                    401,
                    {"status": "error", "message": "Not logged in"},
                    headers=[("Set-Cookie", self.build_cookie_clear_header())],
                )
                return None
            if user.get("disabled"):
                self.send_json(
                    403,
                    {"status": "error", "message": "Account disabled"},
                    headers=[("Set-Cookie", self.build_cookie_clear_header())],
                )
                return None
        return session

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path.startswith("/api/"):
                return self.handle_api_get(parsed.path)
            return self.serve_static(parsed.path)
        except Exception as e:
            safe_print(f"Unhandled GET error: {repr(e)} path={self.path!r}")
            try:
                self.send_error(500)
            except Exception:
                return

    def do_HEAD(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path.startswith("/api/"):
                self.send_error(405)
                return
            return self.serve_static(parsed.path, head_only=True)
        except Exception as e:
            safe_print(f"Unhandled HEAD error: {repr(e)} path={self.path!r}")
            try:
                self.send_error(500)
            except Exception:
                return

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path.startswith("/api/"):
                return self.handle_api_post(parsed.path)
            self.send_error(404)
        except Exception as e:
            safe_print(f"Unhandled POST error: {repr(e)} path={self.path!r}")
            try:
                self.send_error(500)
            except Exception:
                return

    def handle_api_get(self, path):
        if path == "/api/session":
            session = self.get_session()
            if not session:
                return self.send_json(200, {"status": "success", "logged_in": False})
            username = session.get("username")
            with USERS_LOCK:
                user = USERS.get(str(username)) if username else None
                if not isinstance(user, dict):
                    return self.send_json(200, {"status": "success", "logged_in": False})
                ensure_user_defaults(user)
                full_name = str(user.get("name") or "")
                sender_ids = list(user.get("sender_ids") or [])
                approved = [s for s in sender_ids if isinstance(s, dict) and s.get("status") == "approved"]
                display_brand = (approved[0].get("name") if approved else "") or ""
                sms_credits = int(user.get("sms_credits") or 0)
                is_free = bool(user.get("is_free"))
            return self.send_json(
                200,
                {
                    "status": "success",
                    "logged_in": True,
                    "username": username,
                    "name": full_name,
                    "is_free": is_free,
                    "brandname": display_brand,
                    "is_admin": bool(session.get("is_admin")),
                    "sms_credits": sms_credits,
                    "sender_ids": [
                        {"name": s.get("name"), "status": s.get("status"), "created_at": s.get("created_at"), "approved_at": s.get("approved_at")}
                        for s in sender_ids
                        if isinstance(s, dict)
                    ],
                    "special_day_sender_ids": list(SPECIAL_DAY_SENDER_IDS),
                },
            )

        if path == "/api/contacts":
            session = self.require_session()
            if not session:
                return

            with CONTACTS_LOCK:
                items = list(CONTACTS.values())
            items.sort(key=lambda x: x.get("last_sent") or "", reverse=True)
            return self.send_json(200, {"status": "success", "contacts": items})

        if path == "/api/ads":
            session = self.get_session()
            if session and not session.get("username"):
                session = None
            out = {
                "status": "success",
                "home_ads": list(HOME_ADS),
                "special_ads": list(SPECIAL_ADS),
                "home_preview_message": str(HOME_PREVIEW_MESSAGE or ""),
                "special_preview_message": str(SPECIAL_PREVIEW_MESSAGE or ""),
            }
            return self.send_json(200, out)

        if path == "/api/public/trusted-brands":
            out = []
            for b in list(TRUSTED_BRANDS):
                if not isinstance(b, dict):
                    continue
                name = " ".join(str(b.get("name") or "").strip().split())
                logo = str(b.get("logo") or "").strip()
                if name:
                    out.append({"name": name, "logo": logo})
            return self.send_json(200, {"status": "success", "brands": out[:60], "count": len(out)})

        if path == "/api/public/brands":
            brands = set()
            with USERS_LOCK:
                users = list(USERS.values())
            for user in users:
                if not isinstance(user, dict):
                    continue
                sender_ids = user.get("sender_ids") or []
                if not isinstance(sender_ids, list):
                    continue
                for s in sender_ids:
                    if not isinstance(s, dict):
                        continue
                    if s.get("status") != "approved":
                        continue
                    name = " ".join(str(s.get("name") or "").strip().split())
                    if name:
                        brands.add(name)
            out = sorted(brands, key=lambda x: x.lower())
            return self.send_json(200, {"status": "success", "brands": out[:60], "count": len(out)})

        if path == "/api/templates":
            session = self.require_session()
            if not session:
                return
            username = session.get("username")
            if not username:
                return self.send_json(401, {"status": "error", "message": "Not logged in"})

            with USERS_LOCK:
                user = USERS.get(str(username))
                if not user:
                    return self.send_json(401, {"status": "error", "message": "Not logged in"})
                ensure_user_defaults(user)
                user_templates = list(user.get("templates") or [])

            user_templates.sort(key=lambda x: x.get("last_used") or x.get("created_at") or "", reverse=True)
            out = []
            for t in ADMIN_TEMPLATES:
                if not isinstance(t, dict):
                    continue
                out.append(
                    {
                        "id": t.get("id"),
                        "title": t.get("title"),
                        "text": t.get("text"),
                        "created_at": t.get("created_at"),
                        "last_used": None,
                        "source": "admin",
                        "can_delete": bool(session.get("is_admin")),
                    }
                )
            for t in user_templates:
                if not isinstance(t, dict):
                    continue
                out.append(
                    {
                        "id": t.get("id"),
                        "title": t.get("title"),
                        "text": t.get("text"),
                        "created_at": t.get("created_at"),
                        "last_used": t.get("last_used"),
                        "source": "user",
                        "can_delete": bool(session.get("is_admin")),
                    }
                )
            out.sort(key=lambda x: x.get("last_used") or x.get("created_at") or "", reverse=True)
            return self.send_json(200, {"status": "success", "templates": out})

        if path == "/api/admin/templates":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})
            return self.send_json(200, {"status": "success", "templates": list(ADMIN_TEMPLATES)})

        if path == "/api/special-days":
            session = self.require_session()
            if not session:
                return
            return self.send_json(200, {"status": "success", "special_day_sender_ids": list(SPECIAL_DAY_SENDER_IDS)})

        if path == "/api/admin/sender-ids":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            pending = []
            approved = []
            with USERS_LOCK:
                for uname, u in USERS.items():
                    if not isinstance(u, dict):
                        continue
                    ensure_user_defaults(u)
                    for s in (u.get("sender_ids") or []):
                        if not isinstance(s, dict):
                            continue
                        if s.get("status") == "pending":
                            pending.append(
                                {
                                    "username": uname,
                                    "name": s.get("name"),
                                    "status": s.get("status"),
                                    "created_at": s.get("created_at"),
                                }
                            )
                        if s.get("status") == "approved":
                            approved.append(
                                {
                                    "username": uname,
                                    "name": s.get("name"),
                                    "status": s.get("status"),
                                    "created_at": s.get("created_at"),
                                    "approved_at": s.get("approved_at"),
                                }
                            )
            pending.sort(key=lambda x: x.get("created_at") or "", reverse=True)
            approved.sort(key=lambda x: x.get("approved_at") or x.get("created_at") or "", reverse=True)
            return self.send_json(200, {"status": "success", "pending": pending, "approved": approved})

        if path == "/api/admin/special-days":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})
            return self.send_json(200, {"status": "success", "special_day_sender_ids": list(SPECIAL_DAY_SENDER_IDS)})

        if path == "/api/admin/users":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            with USERS_LOCK:
                items = []
                for u in USERS.values():
                    if not isinstance(u, dict):
                        continue
                    ensure_user_defaults(u)
                    sender_ids = list(u.get("sender_ids") or [])
                    approved = [s for s in sender_ids if isinstance(s, dict) and s.get("status") == "approved" and s.get("name")]
                    pending_count = len([s for s in sender_ids if isinstance(s, dict) and s.get("status") == "pending"])
                    items.append(
                        {
                            "username": u.get("username"),
                            "name": u.get("name") or "",
                            "is_free": bool(u.get("is_free")),
                            "brandname": (approved[0].get("name") if approved else ""),
                            "pending_sender_ids": pending_count,
                            "is_admin": bool(u.get("is_admin")),
                            "disabled": bool(u.get("disabled")),
                            "created_at": u.get("created_at"),
                        }
                    )
            items.sort(key=lambda x: (x.get("is_admin") is not True, x.get("username") or ""))
            return self.send_json(200, {"status": "success", "users": items})

        if path == "/api/admin/free-users":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            items = []
            with USERS_LOCK:
                for u in USERS.values():
                    if not isinstance(u, dict):
                        continue
                    ensure_user_defaults(u)
                    if bool(u.get("is_admin")):
                        continue
                    if not bool(u.get("is_free")):
                        continue
                    sender_ids = list(u.get("sender_ids") or [])
                    approved = [s for s in sender_ids if isinstance(s, dict) and s.get("status") == "approved" and s.get("name")]
                    items.append(
                        {
                            "username": u.get("username"),
                            "name": u.get("name") or "",
                            "brandname": (approved[0].get("name") if approved else ""),
                            "created_at": u.get("created_at"),
                        }
                    )
            items.sort(key=lambda x: x.get("username") or "")
            return self.send_json(200, {"status": "success", "free_users": items})

        if path == "/api/admin/sms-logs":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query or "")
            try:
                limit = int((qs.get("limit") or ["50"])[0])
            except Exception:
                limit = 50
            if limit < 1:
                limit = 1
            if limit > 200:
                limit = 200

            if _pg_enabled():
                try:
                    _pg_init_schema()
                    conn = _pg_conn()
                    rows = []
                    with conn.cursor() as cur:
                        cur.execute("SELECT entry FROM bh_sms_logs ORDER BY id DESC LIMIT %s", (limit,))
                        rows = cur.fetchall() or []
                    out = []
                    for r in rows:
                        if not r:
                            continue
                        v = r[0]
                        if isinstance(v, str):
                            try:
                                v = json.loads(v)
                            except Exception:
                                continue
                        if isinstance(v, dict):
                            out.append(v)
                    return self.send_json(200, {"status": "success", "logs": out})
                except Exception:
                    return self.send_json(500, {"status": "error", "message": "Failed to read SMS logs"})

            lines = []
            try:
                if SMS_LOG_FILE.exists():
                    with SMS_LOG_LOCK:
                        with open(SMS_LOG_FILE, "r", encoding="utf-8") as f:
                            lines = f.readlines()
            except Exception:
                lines = []

            out = []
            for line in lines[-limit:]:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
            out.reverse()
            return self.send_json(200, {"status": "success", "logs": out})

        if path == "/api/admin/stats/users":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query or "")
            try:
                days = int((qs.get("days") or ["0"])[0])
            except Exception:
                days = 0
            if days < 0:
                days = 0
            if days > 365:
                days = 365

            cutoff = None
            if days > 0:
                cutoff = utc_now_ts() - (days * 86400)

            try:
                with USERS_LOCK:
                    users_snapshot = {str(k): (v.copy() if isinstance(v, dict) else None) for k, v in USERS.items()}
            except Exception:
                users_snapshot = {}

            lines = []
            try:
                if SMS_LOG_FILE.exists():
                    with SMS_LOG_LOCK:
                        with open(SMS_LOG_FILE, "r", encoding="utf-8") as f:
                            lines = f.readlines()
            except Exception:
                lines = []
            if len(lines) > 20000:
                lines = lines[-20000:]

            totals = {}
            total_events = 0
            total_recipients = 0
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                if not isinstance(entry, dict):
                    continue
                ts = str(entry.get("ts") or "")
                if cutoff is not None and ts:
                    try:
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        if int(dt.timestamp()) < int(cutoff):
                            continue
                    except Exception:
                        continue
                username = str(entry.get("username") or "").strip()
                if not username:
                    continue
                to_list = entry.get("to")
                if isinstance(to_list, list):
                    rc = len([x for x in to_list if x])
                else:
                    rc = 1
                brand = str(entry.get("brandname") or "").strip()
                total_events += 1
                total_recipients += rc
                cur = totals.get(username) or {"username": username, "total_sends": 0, "total_recipients": 0, "last_sent": "", "brandname": ""}
                cur["total_sends"] = int(cur.get("total_sends") or 0) + 1
                cur["total_recipients"] = int(cur.get("total_recipients") or 0) + int(rc)
                if brand and not cur.get("brandname"):
                    cur["brandname"] = brand
                if ts and (not cur.get("last_sent") or str(ts) > str(cur.get("last_sent") or "")):
                    cur["last_sent"] = ts
                totals[username] = cur

            out = []
            for uname, agg in totals.items():
                user = users_snapshot.get(str(uname))
                name = ""
                approved_brand = ""
                is_admin = False
                if isinstance(user, dict):
                    name = str(user.get("name") or "")
                    is_admin = bool(user.get("is_admin"))
                    sender_ids = list(user.get("sender_ids") or [])
                    approved = [s for s in sender_ids if isinstance(s, dict) and s.get("status") == "approved" and s.get("name")]
                    approved_brand = (approved[0].get("name") if approved else "") or ""
                row = {
                    "username": agg.get("username"),
                    "name": name,
                    "brandname": approved_brand or agg.get("brandname") or "",
                    "is_admin": is_admin,
                    "total_sends": int(agg.get("total_sends") or 0),
                    "total_recipients": int(agg.get("total_recipients") or 0),
                    "last_sent": agg.get("last_sent") or "",
                }
                out.append(row)
            out.sort(key=lambda x: (-(int(x.get("total_recipients") or 0)), -(int(x.get("total_sends") or 0)), str(x.get("username") or "")))
            return self.send_json(
                200,
                {
                    "status": "success",
                    "days": days,
                    "total_events": total_events,
                    "total_recipients": total_recipients,
                    "top_users": out[:20],
                    "count_users": len(out),
                },
            )

        if path == "/api/paystack/verify":
            session = self.get_session()
            session_username = str(session.get("username") or "") if isinstance(session, dict) else ""

            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query or "")
            reference = str((qs.get("reference") or [""])[0]).strip()
            if not reference:
                return self.send_json(400, {"status": "error", "message": "Missing reference"})

            secret_key = (os.environ.get("PAYSTACK_SECRET_KEY") or "").strip()
            if not secret_key:
                return self.send_json(500, {"status": "error", "message": "Missing PAYSTACK_SECRET_KEY on the server"})

            url = "https://api.paystack.co/transaction/verify/" + urllib.parse.quote(reference)
            req = urllib.request.Request(
                url,
                method="GET",
                headers={
                    "Authorization": f"Bearer {secret_key}",
                    "Accept": "application/json",
                    "User-Agent": "Mozilla/5.0",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    raw = resp.read().decode("utf-8", errors="replace")
                data = json.loads(raw)
            except urllib.error.HTTPError as e:
                try:
                    body = e.read().decode("utf-8", errors="replace")
                except Exception:
                    body = ""
                safe_print(f"Paystack verify HTTPError code={getattr(e, 'code', '')} body={body[:800]}")
                return self.send_json(
                    502,
                    {
                        "status": "error",
                        "message": "Failed to verify payment",
                        "http_status": int(getattr(e, "code", 0) or 0),
                        "detail": body[:800],
                    },
                )
            except urllib.error.URLError as e:
                safe_print(f"Paystack verify URLError: {repr(e)}")
                return self.send_json(502, {"status": "error", "message": "Failed to reach Paystack", "detail": repr(e)})
            except Exception as e:
                safe_print(f"Paystack verify error: {repr(e)}")
                return self.send_json(502, {"status": "error", "message": "Failed to verify payment", "detail": repr(e)})

            if not isinstance(data, dict) or not data.get("status"):
                return self.send_json(502, {"status": "error", "message": "Invalid Paystack response"})
            tx = data.get("data") if isinstance(data.get("data"), dict) else {}
            if str(tx.get("status") or "").lower() != "success":
                return self.send_json(400, {"status": "error", "message": "Payment not successful", "reference": reference})

            amount_pesewas = int(tx.get("amount") or 0)
            amount_ghs = amount_pesewas // 100

            meta = tx.get("metadata") if isinstance(tx.get("metadata"), dict) else {}
            meta_username = str(meta.get("username") or "").strip()
            meta_sms = meta.get("sms")
            meta_ghs = meta.get("ghs")

            sms = None
            if meta_sms is not None and str(meta_sms).strip() != "":
                try:
                    sms = int(meta_sms)
                except Exception:
                    sms = None

            if sms is not None and meta_ghs is not None and str(meta_ghs).strip() != "":
                try:
                    if int(meta_ghs) != int(amount_ghs):
                        sms = None
                except Exception:
                    sms = None

            if sms is None:
                for p in SUBSCRIPTION_PLANS:
                    if int(p.get("ghs") or 0) == int(amount_ghs):
                        sms = int(p.get("sms") or 0)
                        break

            if not sms:
                return self.send_json(400, {"status": "error", "message": "Unknown plan amount", "reference": reference})

            credited_username = meta_username or session_username
            if not credited_username:
                return self.send_json(400, {"status": "error", "message": "Missing username (session expired and no Paystack metadata)", "reference": reference})

            credited_refs = STORE.get("paystack_credited_refs")
            if not isinstance(credited_refs, dict):
                credited_refs = {}

            if reference in credited_refs:
                info = credited_refs.get(reference) if isinstance(credited_refs.get(reference), dict) else {}
                credited_username2 = str(info.get("username") or credited_username)
                out = {"status": "success", "reference": reference, "credited_sms": 0, "already_credited": True, "credited_username": credited_username2}
                if session_username and session_username == credited_username2:
                    with USERS_LOCK:
                        user = USERS.get(session_username)
                        if isinstance(user, dict):
                            ensure_user_defaults(user)
                            out["sms_balance"] = int(user.get("sms_credits") or 0)
                        else:
                            out["sms_balance"] = 0
                return self.send_json(200, out)

            with USERS_LOCK:
                user = USERS.get(credited_username)
                if not isinstance(user, dict):
                    return self.send_json(404, {"status": "error", "message": "Account not found for this payment", "reference": reference})
                ensure_user_defaults(user)
                user["has_purchased"] = True
                user["sms_credits"] = int(user.get("sms_credits") or 0) + int(sms)
                USERS[credited_username] = user
                credited_refs[reference] = {
                    "username": credited_username,
                    "sms": int(sms),
                    "ghs": int(amount_ghs),
                    "credited_at": utc_now_iso(),
                    "source": "verify",
                }
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                STORE["admin_templates"] = ADMIN_TEMPLATES
                STORE["paystack_credited_refs"] = credited_refs
                save_users_to_disk(STORE)
                bal2 = int(user.get("sms_credits") or 0)

            out2 = {"status": "success", "reference": reference, "credited_sms": int(sms), "credited_username": credited_username}
            if session_username and session_username == credited_username:
                out2["sms_balance"] = bal2
            return self.send_json(200, out2)

        return self.send_json(404, {"status": "error", "message": "Not found"})

    def handle_api_post(self, path):
        if path == "/api/logout":
            cookies = parse_cookies(self.headers.get("Cookie"))
            sid = cookies.get(COOKIE_NAME)
            if sid:
                SESSIONS.pop(sid, None)
            return self.send_json(
                200,
                {"status": "success"},
                headers=[("Set-Cookie", self.build_cookie_clear_header())],
            )

        if path == "/api/login":
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            raw_username = str(body.get("username", ""))
            username = normalize_phone_number(raw_username)
            password = str(body.get("password", ""))
            if not username or not (username.isdigit() and 8 <= len(username) <= 15):
                return self.send_json(400, {"status": "error", "message": "Invalid phone number"})
            if not username or not password:
                return self.send_json(400, {"status": "error", "message": "Username and password are required"})

            with USERS_LOCK:
                user = USERS.get(username)
                if isinstance(user, dict):
                    ensure_user_defaults(user)
            if not user or not verify_password(password, str(user.get("password_hash", "")), str(user.get("salt", ""))):
                return self.send_json(401, {"status": "error", "message": "Invalid login"})
            if user.get("disabled"):
                return self.send_json(403, {"status": "error", "message": "Account disabled"})

            sender_ids = list(user.get("sender_ids") or []) if isinstance(user, dict) else []
            approved = [s for s in sender_ids if isinstance(s, dict) and s.get("status") == "approved"]
            display_brand = (approved[0].get("name") if approved else "") or ""
            sms_credits = int(user.get("sms_credits") or 0)

            sid = secrets.token_urlsafe(32)
            expires_at = utc_now_ts() + SESSION_TTL_SECONDS
            SESSIONS[sid] = {
                "username": username,
                "is_admin": bool(user.get("is_admin")),
                "expires_at": expires_at,
            }

            return self.send_json(
                200,
                {
                    "status": "success",
                    "logged_in": True,
                    "username": username,
                    "name": (user.get("name") if isinstance(user, dict) else "") or "",
                    "is_free": bool(user.get("is_free")) if isinstance(user, dict) else False,
                    "brandname": display_brand,
                    "is_admin": bool(user.get("is_admin")),
                    "sms_credits": sms_credits,
                    "sender_ids": [
                        {"name": s.get("name"), "status": s.get("status"), "created_at": s.get("created_at"), "approved_at": s.get("approved_at")}
                        for s in sender_ids
                        if isinstance(s, dict)
                    ],
                    "special_day_sender_ids": list(SPECIAL_DAY_SENDER_IDS),
                },
                headers=[("Set-Cookie", self.build_cookie_header(sid, SESSION_TTL_SECONDS))],
            )

        if path == "/api/paystack/webhook":
            secret_key = (os.environ.get("PAYSTACK_SECRET_KEY") or "").strip()
            if not secret_key:
                return self.send_json(500, {"status": "error", "message": "Missing PAYSTACK_SECRET_KEY on the server"})

            raw = self.read_body_bytes()
            if raw is None:
                return self.send_json(400, {"status": "error", "message": "Invalid body"})

            sig = str(self.headers.get("X-Paystack-Signature") or "").strip()
            expected = hmac.new(secret_key.encode("utf-8"), raw, hashlib.sha512).hexdigest()
            if not sig or not hmac.compare_digest(sig, expected):
                return self.send_json(401, {"status": "error", "message": "Invalid signature"})

            try:
                payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else {}
            except Exception:
                payload = None
            if not isinstance(payload, dict):
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            event = str(payload.get("event") or "").strip().lower()
            if event not in ("charge.success",):
                return self.send_json(200, {"status": "success"})

            tx = payload.get("data") if isinstance(payload.get("data"), dict) else {}
            if str(tx.get("status") or "").lower() != "success":
                return self.send_json(200, {"status": "success"})

            reference = str(tx.get("reference") or "").strip()
            if not reference:
                return self.send_json(200, {"status": "success"})

            amount_pesewas = int(tx.get("amount") or 0)
            amount_ghs = amount_pesewas // 100

            meta = tx.get("metadata") if isinstance(tx.get("metadata"), dict) else {}
            credited_username = str(meta.get("username") or "").strip()
            meta_sms = meta.get("sms")
            meta_ghs = meta.get("ghs")

            sms = None
            if meta_sms is not None and str(meta_sms).strip() != "":
                try:
                    sms = int(meta_sms)
                except Exception:
                    sms = None

            if sms is not None and meta_ghs is not None and str(meta_ghs).strip() != "":
                try:
                    if int(meta_ghs) != int(amount_ghs):
                        sms = None
                except Exception:
                    sms = None

            if sms is None:
                for p in SUBSCRIPTION_PLANS:
                    if int(p.get("ghs") or 0) == int(amount_ghs):
                        sms = int(p.get("sms") or 0)
                        break

            if not sms or not credited_username:
                safe_print(f"Paystack webhook ignored reference={reference} username={credited_username!r} sms={sms!r} amount_ghs={amount_ghs}")
                return self.send_json(200, {"status": "success"})

            credited_refs = STORE.get("paystack_credited_refs")
            if not isinstance(credited_refs, dict):
                credited_refs = {}
            if reference in credited_refs:
                return self.send_json(200, {"status": "success"})

            with USERS_LOCK:
                user = USERS.get(credited_username)
                if not isinstance(user, dict):
                    safe_print(f"Paystack webhook: user not found reference={reference} username={credited_username!r}")
                    return self.send_json(200, {"status": "success"})
                ensure_user_defaults(user)
                user["has_purchased"] = True
                user["sms_credits"] = int(user.get("sms_credits") or 0) + int(sms)
                USERS[credited_username] = user
                credited_refs[reference] = {
                    "username": credited_username,
                    "sms": int(sms),
                    "ghs": int(amount_ghs),
                    "credited_at": utc_now_iso(),
                    "source": "webhook",
                }
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                STORE["admin_templates"] = ADMIN_TEMPLATES
                STORE["paystack_credited_refs"] = credited_refs
                save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success"})

        if path == "/api/paystack/initialize":
            session = self.require_session()
            if not session:
                return
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            email = PAYSTACK_FIXED_EMAIL
            try:
                sms = int(body.get("sms") or 0)
                price = int(body.get("price") or 0)
            except Exception:
                return self.send_json(400, {"status": "error", "message": "Invalid plan"})

            matched = False
            for p in SUBSCRIPTION_PLANS:
                if int(p.get("ghs") or 0) == price and int(p.get("sms") or 0) == sms:
                    matched = True
                    break
            if not matched:
                return self.send_json(400, {"status": "error", "message": "Unknown plan"})

            secret_key = (os.environ.get("PAYSTACK_SECRET_KEY") or "").strip()
            if not secret_key:
                return self.send_json(500, {"status": "error", "message": "Missing PAYSTACK_SECRET_KEY on the server"})

            reference = "BH_" + str(utc_now_ts()) + "_" + secrets.token_hex(6)
            public_base = (os.environ.get("PUBLIC_BASE_URL") or "").strip().rstrip("/")
            if public_base:
                callback_url = public_base + "/index.html?mode=subscription"
            else:
                xf_host = str(self.headers.get("X-Forwarded-Host") or "").strip()
                xf_host = xf_host.split(",")[0].strip()
                host = xf_host or str(self.headers.get("Host") or "").strip()
                scheme = "https" if self.is_https_request() else "http"
                callback_url = (scheme + "://" + host + "/index.html?mode=subscription") if host else None
            payload = {
                "email": email,
                "amount": int(price) * 100,
                "currency": "GHS",
                "reference": reference,
                "metadata": {"username": str(session.get("username") or ""), "sms": sms, "ghs": price},
            }
            if callback_url:
                payload["callback_url"] = callback_url
            req = urllib.request.Request(
                "https://api.paystack.co/transaction/initialize",
                data=json.dumps(payload).encode("utf-8"),
                method="POST",
                headers={
                    "Authorization": f"Bearer {secret_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "Mozilla/5.0",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    raw = resp.read().decode("utf-8", errors="replace")
                data = json.loads(raw)
            except urllib.error.HTTPError as e:
                try:
                    body2 = e.read().decode("utf-8", errors="replace")
                except Exception:
                    body2 = ""
                safe_print(f"Paystack initialize HTTPError code={getattr(e, 'code', '')} body={body2[:800]}")
                return self.send_json(
                    502,
                    {
                        "status": "error",
                        "message": "Failed to initialize payment",
                        "http_status": int(getattr(e, "code", 0) or 0),
                        "detail": body2[:800],
                        "raw_response": body2[:800],
                    },
                )
            except urllib.error.URLError as e:
                safe_print(f"Paystack initialize URLError: {repr(e)}")
                return self.send_json(502, {"status": "error", "message": "Failed to reach Paystack", "detail": repr(e)})
            except Exception as e:
                safe_print(f"Paystack initialize error: {repr(e)}")
                safe_print(traceback.format_exc())
                return self.send_json(502, {"status": "error", "message": "Failed to initialize payment", "detail": repr(e)})

            if not isinstance(data, dict):
                safe_print(f"Paystack initialize unexpected response type={type(data).__name__} raw={raw[:800]}")
                return self.send_json(502, {"status": "error", "message": "Invalid Paystack response", "raw_response": raw[:800]})

            if data.get("status") is not True:
                msg = str(data.get("message") or "Paystack rejected the request")
                safe_print(f"Paystack initialize rejected reference={reference} raw={raw[:800]}")
                return self.send_json(
                    502,
                    {
                        "status": "error",
                        "message": msg,
                        "reference": reference,
                        "paystack": data,
                        "raw_response": raw[:800],
                    },
                )

            d = data.get("data") if isinstance(data.get("data"), dict) else {}
            auth_url = str(d.get("authorization_url") or "").strip()
            if not auth_url:
                safe_print(f"Paystack initialize missing authorization_url reference={reference} raw={raw[:800]}")
                return self.send_json(
                    502,
                    {"status": "error", "message": "Missing authorization URL", "reference": reference, "paystack": data, "raw_response": raw[:800]},
                )

            return self.send_json(200, {"status": "success", "authorization_url": auth_url, "reference": reference})

        if path == "/api/signup/start":
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            name = " ".join(str(body.get("name") or "").strip().split())
            phone = normalize_phone_number(str(body.get("phone") or ""))
            password = str(body.get("password") or "")
            if not name or len(name) < 2 or len(name) > 40:
                return self.send_json(400, {"status": "error", "message": "Name is required"})
            if not phone or not (phone.isdigit() and 8 <= len(phone) <= 15):
                return self.send_json(400, {"status": "error", "message": "Invalid phone number"})
            if len(password) < 4:
                return self.send_json(400, {"status": "error", "message": "Password must be at least 4 characters"})

            with USERS_LOCK:
                if phone in USERS:
                    return self.send_json(409, {"status": "error", "message": "Account already exists"})

            ip = str(getattr(self, "client_address", ("", 0))[0] or "")
            ok1, wait1 = _rate_limit_allow(f"otp:signup:phone:{phone}", OTP_RATE_LIMIT_PER_PHONE, OTP_RATE_WINDOW_SECONDS)
            ok2, wait2 = _rate_limit_allow(f"otp:signup:ip:{ip}", OTP_RATE_LIMIT_PER_IP, OTP_RATE_WINDOW_SECONDS)
            if not ok1 or not ok2:
                wait = max(wait1, wait2)
                return self.send_json(429, {"status": "error", "message": f"Too many OTP requests. Try again in {wait} seconds."})

            code = _new_otp_code()
            now = utc_now_ts()
            OTP_STORE[_otp_key(phone, "signup")] = {
                "otp_hash": _otp_hash(code),
                "expires_at": now + OTP_TTL_SECONDS,
                "attempts": 0,
                "password": password,
                "name": name,
            }
            text = f"Your AyiSun SMS verification code is {code}. Don't share it with anyone."
            sent = _send_otp_sms(phone, text)
            if not sent.get("ok"):
                OTP_STORE.pop(_otp_key(phone, "signup"), None)
                return self.send_json(502, {"status": "error", "message": "Failed to send OTP", "detail": sent.get("error") or sent.get("detail")})

            return self.send_json(200, {"status": "success", "message": "OTP sent"})

        if path == "/api/signup/verify":
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            phone = normalize_phone_number(str(body.get("phone") or ""))
            otp = str(body.get("otp") or "").strip()
            if not phone or not (phone.isdigit() and 8 <= len(phone) <= 15):
                return self.send_json(400, {"status": "error", "message": "Invalid phone number"})
            if not _is_valid_otp(otp):
                return self.send_json(400, {"status": "error", "message": "Invalid OTP"})

            key = _otp_key(phone, "signup")
            rec = OTP_STORE.get(key)
            if not isinstance(rec, dict):
                return self.send_json(400, {"status": "error", "message": "OTP expired. Request a new code."})
            if int(rec.get("expires_at") or 0) <= utc_now_ts():
                OTP_STORE.pop(key, None)
                return self.send_json(400, {"status": "error", "message": "OTP expired. Request a new code."})
            rec["attempts"] = int(rec.get("attempts") or 0) + 1
            if rec["attempts"] > OTP_MAX_ATTEMPTS:
                OTP_STORE.pop(key, None)
                return self.send_json(400, {"status": "error", "message": "Too many attempts. Request a new code."})
            if not hmac.compare_digest(str(rec.get("otp_hash") or ""), _otp_hash(otp)):
                OTP_STORE[key] = rec
                return self.send_json(400, {"status": "error", "message": "Wrong OTP"})

            password = str(rec.get("password") or "")
            full_name = " ".join(str(rec.get("name") or "").strip().split())
            OTP_STORE.pop(key, None)

            with USERS_LOCK:
                if phone in USERS:
                    return self.send_json(409, {"status": "error", "message": "Account already exists"})
                hp = hash_password(password)
                now_iso = utc_now_iso()
                user = {
                    "username": phone,
                    "name": full_name,
                    "brandname": "",
                    "password_hash": hp["hash"],
                    "salt": hp["salt"],
                    "is_admin": bool(phone == ADMIN_PHONE),
                    "disabled": False,
                    "is_free": False,
                    "templates": [],
                    "created_at": now_iso,
                    "phone": phone,
                    "phone_verified": True,
                    "sms_credits": NEW_ACCOUNT_FREE_SMS_CREDITS,
                    "sender_ids": [],
                }
                USERS[phone] = user
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                STORE["admin_templates"] = ADMIN_TEMPLATES
                save_users_to_disk(STORE)

            return _create_session_and_response(self, phone, user)

        if path == "/api/password-reset/start":
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            phone = normalize_phone_number(str(body.get("phone") or ""))
            if not phone or not (phone.isdigit() and 8 <= len(phone) <= 15):
                return self.send_json(400, {"status": "error", "message": "Invalid phone number"})

            with USERS_LOCK:
                if phone not in USERS:
                    return self.send_json(404, {"status": "error", "message": "Account not found"})

            ip = str(getattr(self, "client_address", ("", 0))[0] or "")
            ok1, wait1 = _rate_limit_allow(f"otp:reset:phone:{phone}", OTP_RATE_LIMIT_PER_PHONE, OTP_RATE_WINDOW_SECONDS)
            ok2, wait2 = _rate_limit_allow(f"otp:reset:ip:{ip}", OTP_RATE_LIMIT_PER_IP, OTP_RATE_WINDOW_SECONDS)
            if not ok1 or not ok2:
                wait = max(wait1, wait2)
                return self.send_json(429, {"status": "error", "message": f"Too many OTP requests. Try again in {wait} seconds."})

            code = _new_otp_code()
            now = utc_now_ts()
            OTP_STORE[_otp_key(phone, "reset")] = {
                "otp_hash": _otp_hash(code),
                "expires_at": now + OTP_TTL_SECONDS,
                "attempts": 0,
            }
            text = f"Your AyiSun SMS password reset code is {code}. Don't share it with anyone."
            sent = _send_otp_sms(phone, text)
            if not sent.get("ok"):
                OTP_STORE.pop(_otp_key(phone, "reset"), None)
                return self.send_json(502, {"status": "error", "message": "Failed to send OTP", "detail": sent.get("error") or sent.get("detail")})

            return self.send_json(200, {"status": "success", "message": "OTP sent"})

        if path == "/api/password-reset/check":
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            phone = normalize_phone_number(str(body.get("phone") or ""))
            otp = str(body.get("otp") or "").strip()
            if not phone or not (phone.isdigit() and 8 <= len(phone) <= 15):
                return self.send_json(400, {"status": "error", "message": "Invalid phone number"})
            if not _is_valid_otp(otp):
                return self.send_json(400, {"status": "error", "message": "Invalid OTP"})

            key = _otp_key(phone, "reset")
            rec = OTP_STORE.get(key)
            if not isinstance(rec, dict):
                return self.send_json(400, {"status": "error", "message": "OTP expired. Request a new code."})
            if int(rec.get("expires_at") or 0) <= utc_now_ts():
                OTP_STORE.pop(key, None)
                return self.send_json(400, {"status": "error", "message": "OTP expired. Request a new code."})
            rec["attempts"] = int(rec.get("attempts") or 0) + 1
            if rec["attempts"] > OTP_MAX_ATTEMPTS:
                OTP_STORE.pop(key, None)
                return self.send_json(400, {"status": "error", "message": "Too many attempts. Request a new code."})
            if not hmac.compare_digest(str(rec.get("otp_hash") or ""), _otp_hash(otp)):
                OTP_STORE[key] = rec
                return self.send_json(400, {"status": "error", "message": "Wrong OTP"})

            rec["verified"] = True
            rec["verified_at"] = utc_now_ts()
            OTP_STORE[key] = rec
            return self.send_json(200, {"status": "success", "message": "OTP verified"})

        if path == "/api/password-reset/verify":
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            phone = normalize_phone_number(str(body.get("phone") or ""))
            otp = str(body.get("otp") or "").strip()
            new_password = str(body.get("newPassword") or "")
            if not phone or not (phone.isdigit() and 8 <= len(phone) <= 15):
                return self.send_json(400, {"status": "error", "message": "Invalid phone number"})
            if not _is_valid_otp(otp):
                return self.send_json(400, {"status": "error", "message": "Invalid OTP"})
            if len(new_password) < 4:
                return self.send_json(400, {"status": "error", "message": "Password must be at least 4 characters"})

            key = _otp_key(phone, "reset")
            rec = OTP_STORE.get(key)
            if not isinstance(rec, dict):
                return self.send_json(400, {"status": "error", "message": "OTP expired. Request a new code."})
            if int(rec.get("expires_at") or 0) <= utc_now_ts():
                OTP_STORE.pop(key, None)
                return self.send_json(400, {"status": "error", "message": "OTP expired. Request a new code."})
            rec["attempts"] = int(rec.get("attempts") or 0) + 1
            if rec["attempts"] > OTP_MAX_ATTEMPTS:
                OTP_STORE.pop(key, None)
                return self.send_json(400, {"status": "error", "message": "Too many attempts. Request a new code."})
            if not hmac.compare_digest(str(rec.get("otp_hash") or ""), _otp_hash(otp)):
                OTP_STORE[key] = rec
                return self.send_json(400, {"status": "error", "message": "Wrong OTP"})
            OTP_STORE.pop(key, None)

            with USERS_LOCK:
                user = USERS.get(phone)
                if not isinstance(user, dict):
                    return self.send_json(404, {"status": "error", "message": "Account not found"})
                ensure_user_defaults(user)
                hp = hash_password(new_password)
                user["password_hash"] = hp["hash"]
                user["salt"] = hp["salt"]
                USERS[phone] = user
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                STORE["admin_templates"] = ADMIN_TEMPLATES
                save_users_to_disk(STORE)

            return _create_session_and_response(self, phone, user)

        if path == "/api/sender-ids":
            session = self.require_session()
            if not session:
                return
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            name = normalize_sender_id(str(body.get("name", "")))
            if not is_valid_sender_id(name):
                return self.send_json(400, {"status": "error", "message": "Sender ID must be max 11 letters/numbers/spaces"})

            username = str(session.get("username") or "")
            nk = sender_id_key(name)
            with USERS_LOCK:
                user = USERS.get(username)
                if not isinstance(user, dict):
                    return self.send_json(401, {"status": "error", "message": "Not logged in"})
                ensure_user_defaults(user)
                for u_name, u in USERS.items():
                    if not isinstance(u, dict):
                        continue
                    ensure_user_defaults(u)
                    for s in (u.get("sender_ids") or []):
                        if isinstance(s, dict) and sender_id_key(str(s.get("name", ""))) == nk:
                            if u_name != username:
                                return self.send_json(409, {"status": "error", "message": "Sender ID already used by another account"})
                            return self.send_json(200, {"status": "success", "sender_id": {"name": s.get("name"), "status": s.get("status")}})
                for s in SPECIAL_DAY_SENDER_IDS:
                    if sender_id_key(str(s)) == nk:
                        return self.send_json(409, {"status": "error", "message": "Sender ID already used by Special Day"})

                now = utc_now_iso()
                user["sender_ids"].append({"name": name, "status": "pending", "created_at": now, "approved_at": None})
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success", "sender_id": {"name": name, "status": "pending"}})

        if path == "/api/admin/sender-ids/approve":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            target_username = normalize_username(str(body.get("username", "")))
            name = normalize_sender_id(str(body.get("name", "")))
            if not target_username or not name:
                return self.send_json(400, {"status": "error", "message": "username and name are required"})

            nk = sender_id_key(name)
            with USERS_LOCK:
                u = USERS.get(target_username)
                if not isinstance(u, dict):
                    return self.send_json(404, {"status": "error", "message": "User not found"})
                ensure_user_defaults(u)
                for other_name, other in USERS.items():
                    if other_name == target_username or not isinstance(other, dict):
                        continue
                    ensure_user_defaults(other)
                    for s in (other.get("sender_ids") or []):
                        if isinstance(s, dict) and sender_id_key(str(s.get("name", ""))) == nk:
                            return self.send_json(409, {"status": "error", "message": "Sender ID already used by another account"})
                for s in SPECIAL_DAY_SENDER_IDS:
                    if sender_id_key(str(s)) == nk:
                        return self.send_json(409, {"status": "error", "message": "Sender ID already used by Special Day"})

                updated = False
                now = utc_now_iso()
                for s in (u.get("sender_ids") or []):
                    if isinstance(s, dict) and sender_id_key(str(s.get("name", ""))) == nk:
                        s["status"] = "approved"
                        s["approved_at"] = now
                        updated = True
                        break
                if not updated:
                    return self.send_json(404, {"status": "error", "message": "Sender ID not found"})

                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success"})

        if path == "/api/admin/sender-ids/delete":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            target_username = normalize_username(str(body.get("username", "")))
            name = normalize_sender_id(str(body.get("name", "")))
            if not target_username or not name:
                return self.send_json(400, {"status": "error", "message": "username and name are required"})

            nk = sender_id_key(name)
            deleted = False
            with USERS_LOCK:
                u = USERS.get(target_username)
                if not isinstance(u, dict):
                    return self.send_json(404, {"status": "error", "message": "User not found"})
                ensure_user_defaults(u)
                next_sender_ids = []
                for s in (u.get("sender_ids") or []):
                    if not isinstance(s, dict):
                        continue
                    if sender_id_key(str(s.get("name", ""))) == nk:
                        deleted = True
                        continue
                    next_sender_ids.append(s)
                if not deleted:
                    return self.send_json(404, {"status": "error", "message": "Sender ID not found"})
                u["sender_ids"] = next_sender_ids
                USERS[target_username] = u
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                STORE["admin_templates"] = ADMIN_TEMPLATES
                save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success", "deleted": True})

        if path == "/api/admin/special-days/add":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            name = normalize_sender_id(str(body.get("name", "")))
            if not is_valid_sender_id(name):
                return self.send_json(400, {"status": "error", "message": "Sender ID must be max 11 letters/numbers/spaces"})
            nk = sender_id_key(name)
            with USERS_LOCK:
                for u in USERS.values():
                    if not isinstance(u, dict):
                        continue
                    ensure_user_defaults(u)
                    for s in (u.get("sender_ids") or []):
                        if isinstance(s, dict) and sender_id_key(str(s.get("name", ""))) == nk:
                            return self.send_json(409, {"status": "error", "message": "Sender ID already used by an account"})
                for s in SPECIAL_DAY_SENDER_IDS:
                    if sender_id_key(str(s)) == nk:
                        return self.send_json(200, {"status": "success", "special_day_sender_ids": list(SPECIAL_DAY_SENDER_IDS)})
                SPECIAL_DAY_SENDER_IDS.append(name)
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                save_users_to_disk(STORE)
            return self.send_json(200, {"status": "success", "special_day_sender_ids": list(SPECIAL_DAY_SENDER_IDS)})

        if path == "/api/admin/special-days/delete":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            name = normalize_sender_id(str(body.get("name", "")))
            nk = sender_id_key(name)
            with USERS_LOCK:
                SPECIAL_DAY_SENDER_IDS[:] = [s for s in SPECIAL_DAY_SENDER_IDS if sender_id_key(str(s)) != nk]
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                save_users_to_disk(STORE)
            return self.send_json(200, {"status": "success", "special_day_sender_ids": list(SPECIAL_DAY_SENDER_IDS)})

        if path == "/api/admin/users":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            raw_new_username = str(body.get("username", ""))
            new_username = normalize_username(raw_new_username)
            phone_guess = normalize_phone_number(raw_new_username)
            if phone_guess and phone_guess.isdigit() and 8 <= len(phone_guess) <= 15:
                new_username = phone_guess
            new_password = str(body.get("password", ""))
            new_brandname = normalize_sender_id(str(body.get("brandname", "")))

            if not is_valid_username(new_username):
                return self.send_json(400, {"status": "error", "message": "Invalid username"})
            if len(new_password) < 6:
                return self.send_json(400, {"status": "error", "message": "Password must be at least 6 characters"})
            if new_brandname and not is_valid_sender_id(new_brandname):
                return self.send_json(400, {"status": "error", "message": "Invalid Sender ID (max 11 letters/numbers/spaces)"})

            with USERS_LOCK:
                if new_username in USERS:
                    return self.send_json(409, {"status": "error", "message": "Username already exists"})
                if new_brandname:
                    nk = sender_id_key(new_brandname)
                    for u in USERS.values():
                        if not isinstance(u, dict):
                            continue
                        ensure_user_defaults(u)
                        for s in (u.get("sender_ids") or []):
                            if isinstance(s, dict) and sender_id_key(str(s.get("name", ""))) == nk:
                                return self.send_json(409, {"status": "error", "message": "Sender ID already in use"})
                    for s in SPECIAL_DAY_SENDER_IDS:
                        if sender_id_key(str(s)) == nk:
                            return self.send_json(409, {"status": "error", "message": "Sender ID already in use"})

                now = utc_now_iso()
                hp = hash_password(new_password)
                user_obj = {
                    "username": new_username,
                    "brandname": "",
                    "password_hash": hp["hash"],
                    "salt": hp["salt"],
                    "is_admin": bool(new_username == ADMIN_PHONE),
                    "disabled": False,
                    "is_free": False,
                    "templates": [],
                    "sender_ids": [],
                    "created_at": now,
                    "sms_credits": NEW_ACCOUNT_FREE_SMS_CREDITS,
                }
                if new_brandname:
                    user_obj["sender_ids"].append({"name": new_brandname, "status": "pending", "created_at": now, "approved_at": None})
                USERS[new_username] = user_obj
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                save_users_to_disk(STORE)

            return self.send_json(
                200,
                {
                    "status": "success",
                    "user": {"username": new_username, "is_admin": bool(new_username == ADMIN_PHONE)},
                },
            )

        if path == "/api/admin/users/disable":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            target_username = normalize_username(str(body.get("username", "")))
            disabled = bool(body.get("disabled"))
            if not target_username:
                return self.send_json(400, {"status": "error", "message": "Username is required"})

            with USERS_LOCK:
                u = USERS.get(target_username)
                if not u:
                    return self.send_json(404, {"status": "error", "message": "User not found"})
                if u.get("is_admin"):
                    return self.send_json(400, {"status": "error", "message": "Cannot disable admin account"})
                u["disabled"] = disabled
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success", "username": target_username, "disabled": disabled})

        if path == "/api/admin/users/set-free":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            target_username = normalize_username(str(body.get("username", "")))
            is_free = bool(body.get("is_free"))
            if not target_username:
                return self.send_json(400, {"status": "error", "message": "Username is required"})

            with USERS_LOCK:
                u = USERS.get(target_username)
                if not u:
                    return self.send_json(404, {"status": "error", "message": "User not found"})
                if bool(u.get("is_admin")):
                    return self.send_json(400, {"status": "error", "message": "Cannot change admin account"})
                ensure_user_defaults(u)
                u["is_free"] = is_free
                USERS[target_username] = u
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success", "username": target_username, "is_free": is_free})

        if path == "/api/admin/users/reset-password":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            target_username = normalize_username(str(body.get("username", "")))
            new_password = str(body.get("new_password", ""))
            if not target_username:
                return self.send_json(400, {"status": "error", "message": "Username is required"})
            if len(new_password) < 6:
                return self.send_json(400, {"status": "error", "message": "Password must be at least 6 characters"})

            with USERS_LOCK:
                u = USERS.get(target_username)
                if not u:
                    return self.send_json(404, {"status": "error", "message": "User not found"})
                hp = hash_password(new_password)
                u["password_hash"] = hp["hash"]
                u["salt"] = hp["salt"]
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success", "username": target_username})

        if path == "/api/admin/change-password":
            session = self.require_session()
            if not session:
                return
            username = normalize_username(str(session.get("username") or ""))
            if not username:
                return self.send_json(401, {"status": "error", "message": "Not logged in"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            current_password = str(body.get("current_password", ""))
            new_password = str(body.get("new_password", ""))
            if not current_password or not new_password:
                return self.send_json(400, {"status": "error", "message": "Current and new password are required"})
            if len(new_password) < 6:
                return self.send_json(400, {"status": "error", "message": "Password must be at least 6 characters"})

            with USERS_LOCK:
                u = USERS.get(username)
                if not isinstance(u, dict):
                    return self.send_json(404, {"status": "error", "message": "User not found"})
                if not verify_password(current_password, str(u.get("password_hash", "")), str(u.get("salt", ""))):
                    return self.send_json(400, {"status": "error", "message": "Current password is incorrect"})
                hp = hash_password(new_password)
                u["password_hash"] = hp["hash"]
                u["salt"] = hp["salt"]
                USERS[username] = u
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success", "username": username})

        if path == "/api/admin/users/update-brandname":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            target_username = normalize_username(str(body.get("username", "")))
            new_brandname = normalize_brandname(str(body.get("brandname", "")))
            if not target_username:
                return self.send_json(400, {"status": "error", "message": "Username is required"})
            if not is_valid_brandname(new_brandname):
                return self.send_json(400, {"status": "error", "message": "Invalid brandname (3-15 letters/numbers/spaces)"})

            with USERS_LOCK:
                u = USERS.get(target_username)
                if not u:
                    return self.send_json(404, {"status": "error", "message": "User not found"})
                for other in USERS.values():
                    if not isinstance(other, dict):
                        continue
                    if normalize_brandname(str(other.get("brandname", ""))) == new_brandname and normalize_username(str(other.get("username", ""))) != target_username:
                        return self.send_json(409, {"status": "error", "message": "Brandname already in use"})

                u["brandname"] = new_brandname
                STORE["users"] = USERS
                STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                save_users_to_disk(STORE)

            for sid, sess in list(SESSIONS.items()):
                if isinstance(sess, dict) and sess.get("username") == target_username:
                    sess["brandname"] = new_brandname
                    SESSIONS[sid] = sess

            return self.send_json(200, {"status": "success", "username": target_username, "brandname": new_brandname})

        if path == "/api/admin/ads/home":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})
            global HOME_PREVIEW_MESSAGE
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            text = str(body.get("text", ""))
            preview_message = body.get("preview_message", None)
            posts = normalize_ads_lines(text)
            HOME_ADS[:] = posts
            STORE["home_ads"] = HOME_ADS
            if preview_message is not None:
                HOME_PREVIEW_MESSAGE = str(preview_message)
                STORE["home_preview_message"] = HOME_PREVIEW_MESSAGE
            save_users_to_disk(STORE)
            return self.send_json(200, {"status": "success", "home_ads": list(HOME_ADS), "home_preview_message": str(HOME_PREVIEW_MESSAGE or "")})

        if path == "/api/admin/ads/special":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})
            global SPECIAL_PREVIEW_MESSAGE
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            text = str(body.get("text", ""))
            preview_message = body.get("preview_message", None)
            posts = normalize_ads_lines(text)
            SPECIAL_ADS[:] = posts
            STORE["special_ads"] = SPECIAL_ADS
            if preview_message is not None:
                SPECIAL_PREVIEW_MESSAGE = str(preview_message)
                STORE["special_preview_message"] = SPECIAL_PREVIEW_MESSAGE
            save_users_to_disk(STORE)
            return self.send_json(200, {"status": "success", "special_ads": list(SPECIAL_ADS), "special_preview_message": str(SPECIAL_PREVIEW_MESSAGE or "")})

        if path == "/api/admin/trusted-brands":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})
            global TRUSTED_BRANDS
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            items = body.get("brands")
            TRUSTED_BRANDS = _clean_trusted_brands(items)
            STORE["trusted_brands"] = TRUSTED_BRANDS
            save_users_to_disk(STORE)
            return self.send_json(200, {"status": "success", "brands": list(TRUSTED_BRANDS), "count": len(TRUSTED_BRANDS)})

        if path == "/api/admin/templates/add":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            template_id = normalize_template_id(body.get("id", ""))
            text = normalize_template_text(str(body.get("text", "")))
            if not is_valid_template_id(template_id):
                return self.send_json(400, {"status": "error", "message": "Invalid template id (letters/numbers/spaces/-/_ only, max 32)"})
            if not text:
                return self.send_json(400, {"status": "error", "message": "Template text is required"})

            now = utc_now_iso()
            created_by = str(session.get("username") or "admin")
            with USERS_LOCK:
                for t in ADMIN_TEMPLATES:
                    if isinstance(t, dict) and str(t.get("id", "")).strip().lower() == template_id.lower():
                        return self.send_json(409, {"status": "error", "message": "Template id already exists"})
                ADMIN_TEMPLATES.append({"id": template_id, "title": template_id, "text": text, "created_at": now, "created_by": created_by})
                STORE["admin_templates"] = ADMIN_TEMPLATES
                save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success", "template": {"id": template_id}})

        if path == "/api/admin/templates/delete":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            template_id = normalize_template_id(body.get("id", ""))
            if not template_id:
                return self.send_json(400, {"status": "error", "message": "Template id is required"})

            removed = False
            with USERS_LOCK:
                next_list = []
                for t in ADMIN_TEMPLATES:
                    if isinstance(t, dict) and str(t.get("id", "")).strip().lower() == template_id.lower():
                        removed = True
                        continue
                    next_list.append(t)
                if removed:
                    ADMIN_TEMPLATES[:] = next_list
                    STORE["admin_templates"] = ADMIN_TEMPLATES
                    save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success", "deleted": removed})

        if path == "/api/templates/delete":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Only admin can delete templates"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            template_id = str(body.get("id", "")).strip()
            if not template_id:
                return self.send_json(400, {"status": "error", "message": "Template id is required"})

            removed = False
            with USERS_LOCK:
                next_admin = []
                for t in ADMIN_TEMPLATES:
                    if isinstance(t, dict) and str(t.get("id", "")).strip().lower() == template_id.lower():
                        removed = True
                        continue
                    next_admin.append(t)
                if removed:
                    ADMIN_TEMPLATES[:] = next_admin

                for uname, user in USERS.items():
                    if not isinstance(user, dict):
                        continue
                    ensure_user_defaults(user)
                    templates = user.get("templates") or []
                    next_templates = []
                    user_removed = False
                    for t in templates:
                        if isinstance(t, dict) and str(t.get("id", "")) == template_id:
                            user_removed = True
                            continue
                        next_templates.append(t)
                    if user_removed:
                        user["templates"] = next_templates
                        USERS[uname] = user
                        removed = True

                if removed:
                    STORE["users"] = USERS
                    STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                    STORE["admin_templates"] = ADMIN_TEMPLATES
                    save_users_to_disk(STORE)

            return self.send_json(200, {"status": "success", "deleted": removed})

        if path == "/api/send-sms-special":
            session = self.require_session()
            if not session:
                return
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            username = str(session.get("username") or "")
            sender_id = normalize_sender_id(str(body.get("senderId", "")))
            message = str(body.get("message", "")).strip()
            recipient_raw = str(body.get("recipientPhone", "")).strip()

            if not sender_id or not message or not recipient_raw:
                return self.send_json(400, {"status": "error", "message": "Please fill in all fields"})
            if sender_id_key(sender_id) not in [sender_id_key(s) for s in SPECIAL_DAY_SENDER_IDS]:
                return self.send_json(400, {"status": "error", "message": "Invalid Special Day Sender ID"})

            recipient_parts = [r for r in recipient_raw.replace(",", " ").split() if r.strip()]
            if not recipient_parts:
                return self.send_json(400, {"status": "error", "message": "Invalid phone number"})
            recipients = []
            for r in recipient_parts:
                n = normalize_phone_number(r)
                if not (n.isdigit() and 8 <= len(n) <= 15):
                    return self.send_json(400, {"status": "error", "message": "Invalid phone number format"})
                recipients.append(n)

            recipient_count = len(recipients)
            with USERS_LOCK:
                user = USERS.get(username)
                if not isinstance(user, dict):
                    return self.send_json(401, {"status": "error", "message": "Not logged in"})
                ensure_user_defaults(user)
                is_admin = bool(user.get("is_admin"))
                is_free = bool(user.get("is_free"))
                has_purchased = bool(user.get("has_purchased"))

                if not is_admin and not is_free and not has_purchased:
                    changed = trial_daily_reset_if_needed(user)
                    if changed:
                        USERS[username] = user
                        STORE["users"] = USERS
                        STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                        STORE["admin_templates"] = ADMIN_TEMPLATES
                        save_users_to_disk(STORE)

                    if recipient_count > 1:
                        return self.send_json(400, {"status": "error", "message": "Free plan: you can only send to 1 contact at a time (no bulk)."})

                    remaining = trial_daily_remaining(user)
                    if remaining < 1:
                        return self.send_json(400, {"status": "error", "message": "Free plan: daily limit reached (10/day). Try again tomorrow or top up."})

                if not is_admin and not is_free and has_purchased:
                    bal = int(user.get("sms_credits") or 0)
                    if bal < recipient_count:
                        return self.send_json(400, {"status": "error", "message": "Insufficient SMS balance", "sms_balance": bal})

            api_key = os.environ.get("ARKESEL_API_KEY")
            if not api_key:
                return self.send_json(500, {"status": "error", "message": "Missing ARKESEL_API_KEY on the server"})

            results = []
            successful = []
            for to in recipients:
                params = {
                    "action": "send-sms",
                    "api_key": api_key,
                    "to": to,
                    "from": sender_id,
                    "sms": message,
                }
                url = "https://sms.arkesel.com/sms/api?" + urllib.parse.urlencode(params)
                try:
                    with urllib.request.urlopen(url, timeout=20) as resp:
                        raw = resp.read().decode("utf-8", errors="replace")
                    try:
                        parsed = json.loads(raw)
                    except Exception:
                        parsed = raw
                    results.append({"to": to, "response": parsed})
                    successful.append(to)
                except urllib.error.HTTPError as e:
                    try:
                        body2 = e.read().decode("utf-8", errors="replace")
                    except Exception:
                        body2 = ""
                    results.append(
                        {
                            "to": to,
                            "error": {
                                "type": "http",
                                "code": getattr(e, "code", None),
                                "reason": str(getattr(e, "reason", "")),
                                "body": body2[:800],
                            },
                        }
                    )
                    safe_print(f"Arkesel send-sms-special failed for to={to}: HTTPError {getattr(e, 'code', '')} {getattr(e, 'reason', '')}: {body2[:800]}")
                    continue
                except urllib.error.URLError as e:
                    detail = repr(e)
                    results.append({"to": to, "error": {"type": "url", "detail": detail}})
                    safe_print(f"Arkesel send-sms-special failed for to={to}: {detail}")
                    continue
                except Exception as e:
                    detail = repr(e)
                    results.append({"to": to, "error": {"type": "exception", "detail": detail}})
                    safe_print(f"Arkesel send-sms-special failed for to={to}: {detail}")
                    continue

            now = utc_now_iso()
            with CONTACTS_LOCK:
                for to in successful:
                    entry = CONTACTS.get(to)
                    if not isinstance(entry, dict):
                        entry = {
                            "phone": to,
                            "first_seen": now,
                            "last_sent": now,
                            "sent_count": 0,
                            "last_username": username,
                            "last_brandname": sender_id,
                        }
                        CONTACTS[to] = entry
                    entry["phone"] = to
                    entry["last_sent"] = now
                    entry["sent_count"] = int(entry.get("sent_count") or 0) + 1
                    entry["last_username"] = username
                    entry["last_brandname"] = sender_id
                    if not entry.get("first_seen"):
                        entry["first_seen"] = now
                save_contacts(CONTACTS)

            append_sms_log(
                {
                    "ts": now,
                    "username": username,
                    "brandname": sender_id,
                    "to": recipients,
                    "message_len": len(message),
                    "message_preview": message[:120],
                    "results": results,
                    "client_ip": self.client_address[0] if self.client_address else None,
                    "mode": "special_day",
                }
            )

            sms_balance = None
            with USERS_LOCK:
                user = USERS.get(username)
                if isinstance(user, dict):
                    ensure_user_defaults(user)
                    is_admin = bool(user.get("is_admin"))
                    is_free = bool(user.get("is_free"))
                    has_purchased = bool(user.get("has_purchased"))

                    if (not is_admin) and (not is_free) and has_purchased:
                        user["sms_credits"] = max(0, int(user.get("sms_credits") or 0) - len(successful))
                        USERS[username] = user
                        STORE["users"] = USERS
                        STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                        STORE["admin_templates"] = ADMIN_TEMPLATES
                        save_users_to_disk(STORE)
                        sms_balance = int(user.get("sms_credits") or 0)

                    if (not is_admin) and (not is_free) and (not has_purchased):
                        trial_daily_reset_if_needed(user)
                        user["trial_daily_used"] = min(int(DAILY_FREE_TRIAL_SMS), int(user.get("trial_daily_used") or 0) + len(successful))
                        USERS[username] = user
                        STORE["users"] = USERS
                        STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                        STORE["admin_templates"] = ADMIN_TEMPLATES
                        save_users_to_disk(STORE)

            template_saved = False
            template_id = None
            cleaned_template = normalize_template_text(message)
            if cleaned_template and username:
                fp = template_fingerprint(cleaned_template)
                template_id = fp[:12]
                with USERS_LOCK:
                    user = USERS.get(str(username))
                    if isinstance(user, dict):
                        ensure_user_defaults(user)
                        templates = user.get("templates") or []
                        found = False
                        for t in templates:
                            if not isinstance(t, dict):
                                continue
                            if str(t.get("fingerprint", "")) == fp:
                                t["last_used"] = now
                                found = True
                                break
                        if not found:
                            templates.append(
                                {
                                    "id": template_id,
                                    "fingerprint": fp,
                                    "text": cleaned_template,
                                    "created_at": now,
                                    "last_used": now,
                                }
                            )
                            user["templates"] = templates
                            template_saved = True
                        STORE["users"] = USERS
                        STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                        STORE["admin_templates"] = ADMIN_TEMPLATES
                        save_users_to_disk(STORE)

            sent_count = len(successful)
            failed_count = max(0, len(recipients) - sent_count)
            if sent_count == 0:
                return self.send_json(502, {"status": "error", "message": "Failed to send SMS", "sent": 0, "failed": failed_count, "results": results})

            out = {
                "status": "success",
                "sent": sent_count,
                "failed": failed_count,
                "partial": failed_count > 0,
                "results": results,
                "template_saved": template_saved,
                "template_id": template_id,
            }
            if sms_balance is not None:
                out["sms_balance"] = sms_balance
            return self.send_json(200, out)

        if path == "/api/send-sms":
            session = self.require_session()
            if not session:
                return

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            message = str(body.get("message", "")).strip()
            recipient_raw = str(body.get("recipientPhone", "")).strip()

            if not message or not recipient_raw:
                return self.send_json(400, {"status": "error", "message": "Please fill in all fields"})

            recipient_parts = [r for r in recipient_raw.replace(",", " ").split() if r.strip()]
            if not recipient_parts:
                return self.send_json(400, {"status": "error", "message": "Invalid phone number"})

            recipients = []
            for r in recipient_parts:
                n = normalize_phone_number(r)
                if not (n.isdigit() and 8 <= len(n) <= 15):
                    return self.send_json(400, {"status": "error", "message": "Invalid phone number format"})
                recipients.append(n)

            username = str(session.get("username") or "")
            sender_id = normalize_sender_id(str(body.get("senderId", "")))
            if not sender_id:
                return self.send_json(400, {"status": "error", "message": "Sender ID is required"})

            nk = sender_id_key(sender_id)
            with USERS_LOCK:
                user = USERS.get(username)
                if not isinstance(user, dict):
                    return self.send_json(401, {"status": "error", "message": "Not logged in"})
                ensure_user_defaults(user)
                is_admin = bool(user.get("is_admin"))
                is_free = bool(user.get("is_free"))
                has_purchased = bool(user.get("has_purchased"))

                if not is_admin and not is_free and not has_purchased:
                    changed = trial_daily_reset_if_needed(user)
                    if changed:
                        USERS[username] = user
                        STORE["users"] = USERS
                        STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                        save_users_to_disk(STORE)

                    if len(recipients) > 1:
                        return self.send_json(400, {"status": "error", "message": "Free plan: you can only send to 1 contact at a time (no bulk)."})

                    remaining = trial_daily_remaining(user)
                    if remaining < 1:
                        return self.send_json(400, {"status": "error", "message": "Free plan: daily limit reached (10/day). Try again tomorrow or top up."})

                allowed = False
                pending = False
                for s in (user.get("sender_ids") or []):
                    if not isinstance(s, dict):
                        continue
                    if sender_id_key(str(s.get("name", ""))) != nk:
                        continue
                    if s.get("status") == "approved":
                        allowed = True
                    else:
                        pending = True
                    break
                if not allowed:
                    if pending:
                        return self.send_json(400, {"status": "error", "message": "Sender ID is pending approval"})
                    return self.send_json(400, {"status": "error", "message": "Sender ID not found"})
                if not is_admin and not is_free:
                    recipient_count = len(recipients)
                    bal = int(user.get("sms_credits") or 0)
                    if bal < recipient_count:
                        return self.send_json(400, {"status": "error", "message": "Insufficient SMS balance", "sms_balance": bal})

            api_key = os.environ.get("ARKESEL_API_KEY")
            if not api_key:
                return self.send_json(500, {"status": "error", "message": "Missing ARKESEL_API_KEY on the server"})

            sender = sender_id

            results = []
            successful = []
            for to in recipients:
                params = {
                    "action": "send-sms",
                    "api_key": api_key,
                    "to": to,
                    "from": sender,
                    "sms": message,
                }
                url = "https://sms.arkesel.com/sms/api?" + urllib.parse.urlencode(params)
                try:
                    with urllib.request.urlopen(url, timeout=20) as resp:
                        raw = resp.read().decode("utf-8", errors="replace")
                    try:
                        parsed = json.loads(raw)
                    except Exception:
                        parsed = raw
                    results.append({"to": to, "response": parsed})
                    successful.append(to)
                except urllib.error.HTTPError as e:
                    try:
                        body = e.read().decode("utf-8", errors="replace")
                    except Exception:
                        body = ""
                    if getattr(e, "code", None) == 422 and not body:
                        body = "Arkesel rejected the request. Check Sender ID and use country code numbers like 233XXXXXXXXX."
                    results.append(
                        {
                            "to": to,
                            "error": {
                                "type": "http",
                                "code": getattr(e, "code", None),
                                "reason": str(getattr(e, "reason", "")),
                                "body": body[:800],
                            },
                        }
                    )
                    safe_print(f"Arkesel send-sms failed for to={to}: HTTPError {getattr(e, 'code', '')} {getattr(e, 'reason', '')}: {body[:800]}")
                    continue
                except urllib.error.URLError as e:
                    detail = repr(e)
                    results.append({"to": to, "error": {"type": "url", "detail": detail}})
                    safe_print(f"Arkesel send-sms failed for to={to}: {detail}")
                    continue
                except Exception as e:
                    detail = repr(e)
                    results.append({"to": to, "error": {"type": "exception", "detail": detail}})
                    safe_print(f"Arkesel send-sms failed for to={to}: {detail}")
                    continue

            now = utc_now_iso()
            with CONTACTS_LOCK:
                for to in successful:
                    entry = CONTACTS.get(to)
                    if not isinstance(entry, dict):
                        entry = {
                            "phone": to,
                            "first_seen": now,
                            "last_sent": now,
                            "sent_count": 0,
                            "last_username": username,
                            "last_brandname": sender,
                        }
                        CONTACTS[to] = entry
                    entry["phone"] = to
                    entry["last_sent"] = now
                    entry["sent_count"] = int(entry.get("sent_count") or 0) + 1
                    entry["last_username"] = username
                    entry["last_brandname"] = sender
                    if not entry.get("first_seen"):
                        entry["first_seen"] = now
                save_contacts(CONTACTS)

            append_sms_log(
                {
                    "ts": now,
                    "username": username,
                    "brandname": sender,
                    "to": recipients,
                    "message_len": len(message),
                    "message_preview": message[:120],
                    "results": results,
                    "client_ip": self.client_address[0] if self.client_address else None,
                }
            )

            sms_balance = None
            with USERS_LOCK:
                user = USERS.get(username)
                if isinstance(user, dict):
                    ensure_user_defaults(user)
                    is_admin = bool(user.get("is_admin"))
                    is_free = bool(user.get("is_free"))
                    has_purchased = bool(user.get("has_purchased"))

                    if (not is_admin) and (not is_free) and has_purchased:
                        user["sms_credits"] = max(0, int(user.get("sms_credits") or 0) - len(successful))
                        USERS[username] = user
                        STORE["users"] = USERS
                        STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                        save_users_to_disk(STORE)
                        sms_balance = int(user.get("sms_credits") or 0)

                    if (not is_admin) and (not is_free) and (not has_purchased):
                        trial_daily_reset_if_needed(user)
                        user["trial_daily_used"] = min(int(DAILY_FREE_TRIAL_SMS), int(user.get("trial_daily_used") or 0) + len(successful))
                        USERS[username] = user
                        STORE["users"] = USERS
                        STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                        save_users_to_disk(STORE)

            template_saved = False
            template_id = None
            cleaned_template = normalize_template_text(message)
            if cleaned_template:
                fp = template_fingerprint(cleaned_template)
                template_id = fp[:12]
                with USERS_LOCK:
                    user = USERS.get(str(username))
                    if isinstance(user, dict):
                        ensure_user_defaults(user)
                        templates = user.get("templates") or []
                        found = False
                        for t in templates:
                            if not isinstance(t, dict):
                                continue
                            if str(t.get("fingerprint", "")) == fp:
                                t["last_used"] = now
                                found = True
                                break
                        if not found:
                            templates.append(
                                {
                                    "id": template_id,
                                    "fingerprint": fp,
                                    "text": cleaned_template,
                                    "created_at": now,
                                    "last_used": now,
                                }
                            )
                            user["templates"] = templates
                            template_saved = True
                        STORE["users"] = USERS
                        STORE["special_day_sender_ids"] = SPECIAL_DAY_SENDER_IDS
                        save_users_to_disk(STORE)

            sent_count = len(successful)
            failed_count = max(0, len(recipients) - sent_count)
            if sent_count == 0:
                return self.send_json(502, {"status": "error", "message": "Failed to send SMS", "sent": 0, "failed": failed_count, "results": results})

            out = {
                "status": "success",
                "sent": sent_count,
                "failed": failed_count,
                "partial": failed_count > 0,
                "results": results,
                "template_saved": template_saved,
                "template_id": template_id,
            }
            if sms_balance is not None:
                out["sms_balance"] = sms_balance
            return self.send_json(200, out)

        return self.send_json(404, {"status": "error", "message": "Not found"})

    def serve_static(self, url_path, head_only=False):
        if url_path == "/":
            url_path = "/index.html"

        if url_path == "/template.html":
            session = self.get_session()
            if not session:
                self.send_response(302)
                self.send_header("Location", "/index.html")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        rel = url_path.lstrip("/")
        rel = rel.replace("\\", "/")
        full_path = (ROOT_DIR / rel).resolve()

        try:
            full_path.relative_to(ROOT_DIR)
        except Exception:
            self.send_error(404)
            return

        if not full_path.exists() or not full_path.is_file():
            self.send_error(404)
            return

        try:
            size = int(full_path.stat().st_size)
        except Exception:
            self.send_error(404)
            return

        self.send_response(200)
        self.send_header("Content-Type", guess_content_type(full_path))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(size))
        self.end_headers()

        if head_only:
            return

        data = full_path.read_bytes()
        self.wfile.write(data)


class BusinessHelpyServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        try:
            safe_print(f"Server error from client={client_address!r}")
            safe_print(traceback.format_exc())
        except Exception:
            return


def main():
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "127.0.0.1").strip() or "127.0.0.1"
    server = BusinessHelpyServer((host, port), Handler)
    cert_file = os.environ.get("HTTPS_CERT_FILE")
    key_file = os.environ.get("HTTPS_KEY_FILE")
    if cert_file and key_file:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=cert_file, keyfile=key_file)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        server.is_https = True
        print(f"Python server running on https://{host}:{port}/")
    else:
        server.is_https = False
        print(f"Python server running on http://{host}:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()