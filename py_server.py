import json
import os
import secrets
import hashlib
import hmac
import threading
import time
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

FREE_SENDER_IDS = [
    "Mothers Day",
    "EnjoyUrDay",
    "Happy Day",
    "Birthday",
    "FATHERS",
    "I LOVE YOU DAY",
    "CONGRATE",
    "GoodMorning",
    "EidGreeting",
    "Eid Salam",
]

SESSIONS = {}

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
        if not USERS_FILE.exists():
            return {"version": 1, "users": {}}
        raw = USERS_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict):
            return {"version": 1, "users": {}}
        users = data.get("users")
        if not isinstance(users, dict):
            return {"version": 1, "users": {}}
        return {"version": 1, "users": users}
    except Exception:
        return {"version": 1, "users": {}}


def save_users_to_disk(users: dict):
    tmp = USERS_FILE.with_suffix(".json.tmp")
    payload = json.dumps({"version": 1, "users": users}, ensure_ascii=False)
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(USERS_FILE)


USERS = load_users_from_disk()["users"]
if not USERS.get("admin"):
    now = utc_now_iso()
    hp = hash_password("admin1234")
    USERS["admin"] = {
        "username": "admin",
        "brandname": "I LOVE U",
        "password_hash": hp["hash"],
        "salt": hp["salt"],
        "is_admin": True,
        "disabled": False,
        "templates": [],
        "created_at": now,
    }
    save_users_to_disk(USERS)


def append_sms_log(entry: dict):
    try:
        line = json.dumps(entry, ensure_ascii=False)
        with SMS_LOG_LOCK:
            with open(SMS_LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        return


def ensure_user_defaults(user: dict):
    changed = False
    if "disabled" not in user:
        user["disabled"] = False
        changed = True
    if "templates" not in user or not isinstance(user.get("templates"), list):
        user["templates"] = []
        changed = True
    return changed


def load_contacts():
    try:
        if not CONTACTS_FILE.exists():
            return {"version": 1, "contacts": {}}
        raw = CONTACTS_FILE.read_text(encoding="utf-8")
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

    def is_https_request(self):
        if FORCE_SECURE_COOKIES:
            return True
        xf_proto = (self.headers.get("X-Forwarded-Proto") or "").strip().lower()
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

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        raw = self.rfile.read(length) if length > 0 else b""
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
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api_get(parsed.path)
        return self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api_post(parsed.path)
        self.send_error(404)

    def handle_api_get(self, path):
        if path == "/api/session":
            session = self.get_session()
            if not session:
                return self.send_json(200, {"status": "success", "logged_in": False})
            return self.send_json(
                200,
                {
                    "status": "success",
                    "logged_in": True,
                    "username": session.get("username"),
                    "brandname": session.get("brandname"),
                    "is_admin": bool(session.get("is_admin")),
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
                templates = list(user.get("templates") or [])

            templates.sort(key=lambda x: x.get("last_used") or x.get("created_at") or "", reverse=True)
            out = []
            for t in templates:
                if not isinstance(t, dict):
                    continue
                out.append(
                    {
                        "id": t.get("id"),
                        "text": t.get("text"),
                        "created_at": t.get("created_at"),
                        "last_used": t.get("last_used"),
                    }
                )
            return self.send_json(200, {"status": "success", "templates": out})

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
                    items.append(
                        {
                            "username": u.get("username"),
                            "brandname": u.get("brandname"),
                            "is_admin": bool(u.get("is_admin")),
                            "disabled": bool(u.get("disabled")),
                            "created_at": u.get("created_at"),
                        }
                    )
            items.sort(key=lambda x: (x.get("is_admin") is not True, x.get("username") or ""))
            return self.send_json(200, {"status": "success", "users": items})

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

            username = normalize_username(str(body.get("username", "")))
            password = str(body.get("password", ""))
            if not username or not password:
                return self.send_json(400, {"status": "error", "message": "Username and password are required"})

            with USERS_LOCK:
                user = USERS.get(username)
            if not user or not verify_password(password, str(user.get("password_hash", "")), str(user.get("salt", ""))):
                return self.send_json(401, {"status": "error", "message": "Invalid login"})
            if user.get("disabled"):
                return self.send_json(403, {"status": "error", "message": "Account disabled"})

            sid = secrets.token_urlsafe(32)
            expires_at = utc_now_ts() + SESSION_TTL_SECONDS
            SESSIONS[sid] = {
                "username": username,
                "brandname": user.get("brandname"),
                "is_admin": bool(user.get("is_admin")),
                "expires_at": expires_at,
            }

            return self.send_json(
                200,
                {
                    "status": "success",
                    "logged_in": True,
                    "username": username,
                    "brandname": user.get("brandname"),
                    "is_admin": bool(user.get("is_admin")),
                },
                headers=[("Set-Cookie", self.build_cookie_header(sid, SESSION_TTL_SECONDS))],
            )

        if path == "/api/admin/users":
            session = self.require_session()
            if not session:
                return
            if not session.get("is_admin"):
                return self.send_json(403, {"status": "error", "message": "Forbidden"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            new_username = normalize_username(str(body.get("username", "")))
            new_password = str(body.get("password", ""))
            new_brandname = normalize_brandname(str(body.get("brandname", "")))

            if not is_valid_username(new_username):
                return self.send_json(400, {"status": "error", "message": "Invalid username"})
            if len(new_password) < 6:
                return self.send_json(400, {"status": "error", "message": "Password must be at least 6 characters"})
            if not is_valid_brandname(new_brandname):
                return self.send_json(400, {"status": "error", "message": "Invalid brandname (3-15 letters/numbers/spaces)"})

            with USERS_LOCK:
                if new_username in USERS:
                    return self.send_json(409, {"status": "error", "message": "Username already exists"})
                for u in USERS.values():
                    if not isinstance(u, dict):
                        continue
                    if normalize_brandname(str(u.get("brandname", ""))) == new_brandname:
                        return self.send_json(409, {"status": "error", "message": "Brandname already in use"})

                now = utc_now_iso()
                hp = hash_password(new_password)
                USERS[new_username] = {
                    "username": new_username,
                    "brandname": new_brandname,
                    "password_hash": hp["hash"],
                    "salt": hp["salt"],
                    "is_admin": False,
                    "disabled": False,
                    "templates": [],
                    "created_at": now,
                }
                save_users_to_disk(USERS)

            return self.send_json(
                200,
                {
                    "status": "success",
                    "user": {"username": new_username, "brandname": new_brandname, "is_admin": False},
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
                save_users_to_disk(USERS)

            return self.send_json(200, {"status": "success", "username": target_username, "disabled": disabled})

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
                save_users_to_disk(USERS)

            return self.send_json(200, {"status": "success", "username": target_username})

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
                save_users_to_disk(USERS)

            for sid, sess in list(SESSIONS.items()):
                if isinstance(sess, dict) and sess.get("username") == target_username:
                    sess["brandname"] = new_brandname
                    SESSIONS[sid] = sess

            return self.send_json(200, {"status": "success", "username": target_username, "brandname": new_brandname})

        if path == "/api/templates/delete":
            session = self.require_session()
            if not session:
                return
            username = session.get("username")
            if not username:
                return self.send_json(401, {"status": "error", "message": "Not logged in"})

            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})
            template_id = str(body.get("id", "")).strip()
            if not template_id:
                return self.send_json(400, {"status": "error", "message": "Template id is required"})

            removed = False
            with USERS_LOCK:
                user = USERS.get(str(username))
                if not user:
                    return self.send_json(401, {"status": "error", "message": "Not logged in"})
                ensure_user_defaults(user)
                templates = user.get("templates") or []
                next_templates = []
                for t in templates:
                    if isinstance(t, dict) and str(t.get("id", "")) == template_id:
                        removed = True
                        continue
                    next_templates.append(t)
                user["templates"] = next_templates
                if removed:
                    save_users_to_disk(USERS)

            return self.send_json(200, {"status": "success", "deleted": removed})

        if path == "/api/send-sms-free":
            body = self.read_json()
            if body is None:
                return self.send_json(400, {"status": "error", "message": "Invalid JSON"})

            sender_id = str(body.get("senderId", "")).strip()
            message = str(body.get("message", "")).strip()
            recipient_raw = str(body.get("recipientPhone", "")).strip()

            if sender_id not in FREE_SENDER_IDS:
                return self.send_json(400, {"status": "error", "message": "Invalid Sender ID"})
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

            api_key = os.environ.get("ARKESEL_API_KEY")
            if not api_key:
                return self.send_json(500, {"status": "error", "message": "Missing ARKESEL_API_KEY on the server"})

            results = []
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
                except urllib.error.HTTPError as e:
                    try:
                        body = e.read().decode("utf-8", errors="replace")
                    except Exception:
                        body = ""
                    if getattr(e, "code", None) == 422 and not body:
                        body = "Arkesel rejected the request. Check Sender ID and use country code numbers like 233XXXXXXXXX."
                    detail = f"HTTPError {getattr(e, 'code', '')} {getattr(e, 'reason', '')}: {body[:800]}"
                    print(f"Arkesel send-sms-free failed for to={to}: {detail}")
                    return self.send_json(502, {"status": "error", "message": "Failed to send SMS", "detail": detail, "raw_response": body[:800]})
                except urllib.error.URLError as e:
                    detail = repr(e)
                    print(f"Arkesel send-sms-free failed for to={to}: {detail}")
                    return self.send_json(502, {"status": "error", "message": "Failed to send SMS", "detail": detail})
                except Exception as e:
                    detail = repr(e)
                    print(f"Arkesel send-sms-free failed for to={to}: {detail}")
                    return self.send_json(502, {"status": "error", "message": "Failed to send SMS", "detail": detail})

            now = utc_now_iso()
            with CONTACTS_LOCK:
                for to in recipients:
                    entry = CONTACTS.get(to)
                    if not isinstance(entry, dict):
                        entry = {
                            "phone": to,
                            "first_seen": now,
                            "last_sent": now,
                            "sent_count": 0,
                            "last_username": "FREE",
                            "last_brandname": sender_id,
                        }
                        CONTACTS[to] = entry
                    entry["phone"] = to
                    entry["last_sent"] = now
                    entry["sent_count"] = int(entry.get("sent_count") or 0) + 1
                    entry["last_username"] = "FREE"
                    entry["last_brandname"] = sender_id
                    if not entry.get("first_seen"):
                        entry["first_seen"] = now
                save_contacts(CONTACTS)

            append_sms_log(
                {
                    "ts": now,
                    "username": "FREE",
                    "brandname": sender_id,
                    "to": recipients,
                    "message_len": len(message),
                    "message_preview": message[:120],
                    "results": results,
                    "client_ip": self.client_address[0] if self.client_address else None,
                    "is_free": True,
                }
            )

            return self.send_json(200, {"status": "success", "results": results})

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

            api_key = os.environ.get("ARKESEL_API_KEY")
            if not api_key:
                return self.send_json(500, {"status": "error", "message": "Missing ARKESEL_API_KEY on the server"})

            sender = session.get("brandname") or "I LOVE U"
            username = session.get("username") or ""

            results = []
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
                except urllib.error.HTTPError as e:
                    try:
                        body = e.read().decode("utf-8", errors="replace")
                    except Exception:
                        body = ""
                    if getattr(e, "code", None) == 422 and not body:
                        body = "Arkesel rejected the request. Check Sender ID and use country code numbers like 233XXXXXXXXX."
                    detail = f"HTTPError {getattr(e, 'code', '')} {getattr(e, 'reason', '')}: {body[:800]}"
                    print(f"Arkesel send-sms failed for to={to}: {detail}")
                    return self.send_json(502, {"status": "error", "message": "Failed to send SMS", "detail": detail, "raw_response": body[:800]})
                except urllib.error.URLError as e:
                    detail = repr(e)
                    print(f"Arkesel send-sms failed for to={to}: {detail}")
                    return self.send_json(502, {"status": "error", "message": "Failed to send SMS", "detail": detail})
                except Exception as e:
                    detail = repr(e)
                    print(f"Arkesel send-sms failed for to={to}: {detail}")
                    return self.send_json(502, {"status": "error", "message": "Failed to send SMS", "detail": detail})

            now = utc_now_iso()
            with CONTACTS_LOCK:
                for to in recipients:
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
                        save_users_to_disk(USERS)

            return self.send_json(200, {"status": "success", "results": results, "template_saved": template_saved, "template_id": template_id})

        return self.send_json(404, {"status": "error", "message": "Not found"})

    def serve_static(self, url_path):
        if url_path == "/":
            url_path = "/index.html"

        if url_path == "/template.html":
            session = self.get_session()
            if not session:
                self.send_response(302)
                self.send_header("Location", "/index.html")
                self.send_header("Cache-Control", "no-store")
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

        data = full_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", guess_content_type(full_path))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    cert_file = os.environ.get("HTTPS_CERT_FILE")
    key_file = os.environ.get("HTTPS_KEY_FILE")
    if cert_file and key_file:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=cert_file, keyfile=key_file)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        server.is_https = True
        print(f"Python server running on https://127.0.0.1:{port}/")
    else:
        server.is_https = False
        print(f"Python server running on http://127.0.0.1:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
