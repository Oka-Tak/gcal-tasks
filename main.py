"""
Unified Google Calendar + Google Tasks web app (self-hosted).

Acts as a thin, two-way client over the Google Calendar API and Google Tasks API.
No local database, no sync engine: every read hits Google live, every
create/edit/complete/delete is written straight back to Google.

Supports connecting several of *your own* Google accounts (personal + work, …)
and merging them into one view. Still single-human: there is no per-visitor
session — access control is expected to be provided in front (Cloudflare Access
/ Tailscale), reinforced here by an optional email allowlist.

See README.md for Google Cloud OAuth setup and Cloudflare Tunnel deployment.
"""

import os
import json
import datetime as dt
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import (
    HTMLResponse,
    RedirectResponse,
    FileResponse,
    JSONResponse,
)

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
CLIENT_SECRETS = Path(os.getenv("CLIENT_SECRETS", BASE_DIR / "client_secret.json"))
# Where per-account tokens live. One file per connected Google account:
# tokens/<email>.json -> {"email": ..., "token": <google creds json>}
TOKENS_DIR = Path(os.getenv("TOKENS_DIR", BASE_DIR / "tokens"))
# Legacy single-account token from earlier versions; migrated on first use.
LEGACY_TOKEN = Path(os.getenv("TOKEN_PATH", BASE_DIR / "token.json"))

# Public base URL the OAuth callback returns to. Loopback by default so Google
# accepts plain http. When you put this behind Cloudflare Tunnel, set this to
# the public https URL (e.g. https://cal.example.com) and add it as an
# authorized redirect URI in the Google Cloud console.
BASE_URL = os.getenv("BASE_URL", "http://localhost:8765").rstrip("/")
REDIRECT_URI = BASE_URL + "/oauth2callback"

# Optional defence in depth: when set (comma-separated), every request must
# carry a Cloudflare Access identity header whose email is in this list.
# Assumes the app is only reachable through the tunnel (bind HOST=127.0.0.1),
# otherwise the header could be spoofed by hitting the port directly.
ALLOWED_EMAILS = {
    e.strip().lower() for e in os.getenv("ALLOWED_EMAILS", "").split(",") if e.strip()
}
ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email"
# Who may embed this app in an <iframe>. 'self' by default; set to a dashboard
# origin (e.g. https://dash.example.com) for the Proxmox dashboard embed.
FRAME_ANCESTORS = os.getenv("FRAME_ANCESTORS", "'self'")

SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
]

# A small stable palette so each account can get a consistent accent colour.
ACCOUNT_PALETTE = [
    "#4f46e5", "#0891b2", "#be185d", "#15803d", "#b45309", "#7c3aed", "#0f766e",
]

# Let google-auth tolerate the small scope reordering Google sometimes returns.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")
# Allow the OAuth callback over plain http ONLY when the callback is loopback
# http. Once BASE_URL is https (behind the tunnel) we must NOT relax transport
# security, so this is conditional rather than unconditional.
if BASE_URL.startswith("http://"):
    os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")

app = FastAPI(title="Calendar + Tasks")

# state -> PKCE code_verifier, held only between /login and /oauth2callback.
_pending_verifiers: dict[str, str] = {}


# --------------------------------------------------------------------------- #
# Security middleware
# --------------------------------------------------------------------------- #
@app.middleware("http")
async def security_layer(request: Request, call_next):
    # Optional email allowlist (Cloudflare Access). Only enforced when configured
    # so local/dev use is unaffected.
    if ALLOWED_EMAILS:
        email = (request.headers.get(ACCESS_EMAIL_HEADER) or "").strip().lower()
        if email not in ALLOWED_EMAILS:
            return JSONResponse({"detail": "forbidden"}, status_code=403)

    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "img-src 'self' data: https:; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; "
        "connect-src 'self'; "
        f"frame-ancestors {FRAME_ANCESTORS}",
    )
    return resp


# --------------------------------------------------------------------------- #
# Per-account credentials
# --------------------------------------------------------------------------- #
def _token_path(email: str) -> Path:
    # Emails never contain a path separator; keep the filename simple and stable.
    return TOKENS_DIR / f"{email}.json"


def _save_account(email: str, creds: Credentials) -> None:
    TOKENS_DIR.mkdir(mode=0o700, exist_ok=True)
    path = _token_path(email)
    path.write_text(
        json.dumps({"email": email, "token": json.loads(creds.to_json())})
    )
    os.chmod(path, 0o600)


def _fetch_email(creds: Credentials) -> str | None:
    try:
        info = (
            build("oauth2", "v2", credentials=creds, cache_discovery=False)
            .userinfo()
            .get()
            .execute()
        )
        return info.get("email")
    except HttpError:
        return None


def _migrate_legacy() -> None:
    """Fold an old single-account token.json into the per-account store once."""
    if not LEGACY_TOKEN.exists():
        return
    try:
        creds = Credentials.from_authorized_user_info(
            json.loads(LEGACY_TOKEN.read_text()), SCOPES
        )
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(GoogleRequest())
        email = _fetch_email(creds) or "default"
        _save_account(email, creds)
    finally:
        # Keep a backup rather than deleting the user's only token outright.
        LEGACY_TOKEN.rename(LEGACY_TOKEN.with_suffix(LEGACY_TOKEN.suffix + ".bak"))


def list_accounts() -> list[dict]:
    """All connected accounts as [{email, creds, color}], refreshing as needed."""
    _migrate_legacy()
    if not TOKENS_DIR.exists():
        return []
    out = []
    for path in sorted(TOKENS_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
            email = data.get("email") or path.stem
            creds = Credentials.from_authorized_user_info(data["token"], SCOPES)
        except (KeyError, ValueError, json.JSONDecodeError):
            continue
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(GoogleRequest())
                _save_account(email, creds)
            except Exception:
                continue  # expired/revoked: skip rather than 500 the whole view
        if creds and creds.valid:
            out.append({"email": email, "creds": creds})
    for i, a in enumerate(out):
        a["color"] = ACCOUNT_PALETTE[i % len(ACCOUNT_PALETTE)]
    return out


def creds_for(email: str) -> Credentials:
    for a in list_accounts():
        if a["email"] == email:
            return a["creds"]
    raise HTTPException(status_code=401, detail=f"account not connected: {email}")


def svc(email: str, api: str, version: str):
    return build(api, version, credentials=creds_for(email), cache_discovery=False)


# --------------------------------------------------------------------------- #
# Auth routes
# --------------------------------------------------------------------------- #
def make_flow() -> Flow:
    if not CLIENT_SECRETS.exists():
        raise HTTPException(
            status_code=500, detail=f"missing {CLIENT_SECRETS.name}; see README"
        )
    return Flow.from_client_secrets_file(
        str(CLIENT_SECRETS), scopes=SCOPES, redirect_uri=REDIRECT_URI
    )


@app.get("/login")
def login():
    """Begin OAuth. Run again later to connect an additional account."""
    flow = make_flow()
    auth_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",  # force a refresh_token to be issued
    )
    # PKCE: the code_verifier generated here must survive until the callback,
    # which runs on a separate Flow instance.
    _pending_verifiers[state] = flow.code_verifier
    return RedirectResponse(auth_url)


@app.get("/oauth2callback")
def oauth2callback(request: Request):
    state = request.query_params.get("state")
    # Validate state as a CSRF token: it must match one we issued. Without this
    # the verifier lookup would silently return None and fail confusingly.
    if not state or state not in _pending_verifiers:
        raise HTTPException(status_code=400, detail="invalid or expired OAuth state")
    flow = make_flow()
    flow.code_verifier = _pending_verifiers.pop(state)
    flow.fetch_token(authorization_response=str(request.url))
    creds = flow.credentials
    email = _fetch_email(creds)
    if not email:
        raise HTTPException(status_code=502, detail="could not read account email")
    _save_account(email, creds)
    return RedirectResponse("/")


@app.get("/api/status")
def status():
    accounts = [{"email": a["email"], "color": a["color"]} for a in list_accounts()]
    return {"authed": bool(accounts), "accounts": accounts}


@app.get("/api/accounts")
def accounts():
    return [{"email": a["email"], "color": a["color"]} for a in list_accounts()]


@app.delete("/api/accounts/{email}")
def disconnect_account(email: str):
    path = _token_path(email)
    if not path.exists():
        raise HTTPException(status_code=404, detail="account not connected")
    path.unlink()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Calendar
# --------------------------------------------------------------------------- #
@app.get("/api/calendars")
def list_calendars():
    out = []
    for a in list_accounts():
        try:
            items = (
                svc(a["email"], "calendar", "v3")
                .calendarList()
                .list()
                .execute()
                .get("items", [])
            )
        except HttpError:
            continue
        for c in items:
            out.append(
                {
                    "account": a["email"],
                    "id": c["id"],
                    "summary": c.get("summaryOverride") or c.get("summary"),
                    "color": c.get("backgroundColor", "#4285f4"),
                    "primary": c.get("primary", False),
                }
            )
    return out


@app.get("/api/events")
def list_events(timeMin: str, timeMax: str):
    """Merged events from every calendar of every connected account."""
    out = []
    for a in list_accounts():
        service = svc(a["email"], "calendar", "v3")
        try:
            cals = service.calendarList().list().execute().get("items", [])
        except HttpError:
            continue
        for c in cals:
            cal_id = c["id"]
            color = c.get("backgroundColor", "#4285f4")
            try:
                resp = (
                    service.events()
                    .list(
                        calendarId=cal_id,
                        timeMin=timeMin,
                        timeMax=timeMax,
                        singleEvents=True,
                        orderBy="startTime",
                        maxResults=2500,
                    )
                    .execute()
                )
            except HttpError:
                continue
            for e in resp.get("items", []):
                if e.get("status") == "cancelled":
                    continue
                out.append(_event_out(e, a["email"], cal_id, color))
    return out


def _event_out(e: dict, account: str, cal_id: str, color: str) -> dict:
    """Serialize a Calendar event, including read-only detail fields (#3)."""
    start = e.get("start", {})
    end = e.get("end", {})
    attendees = [
        {
            "email": at.get("email"),
            "name": at.get("displayName"),
            "response": at.get("responseStatus"),
            "organizer": at.get("organizer", False),
            "self": at.get("self", False),
            "optional": at.get("optional", False),
        }
        for at in e.get("attendees", [])
    ]
    # Pull a video-conference link out of conferenceData if present.
    meet = e.get("hangoutLink")
    if not meet:
        for ep in (e.get("conferenceData", {}) or {}).get("entryPoints", []):
            if ep.get("entryPointType") == "video" and ep.get("uri"):
                meet = ep["uri"]
                break
    attachments = [
        {"title": at.get("title"), "url": at.get("fileUrl"), "icon": at.get("iconLink")}
        for at in e.get("attachments", [])
    ]
    return {
        "account": account,
        "id": e["id"],
        "calendarId": cal_id,
        "color": color,
        "summary": e.get("summary", "(no title)"),
        "location": e.get("location"),
        "description": e.get("description"),
        "allDay": "date" in start,
        "start": start.get("dateTime") or start.get("date"),
        "end": end.get("dateTime") or end.get("date"),
        # detail-only (read-only in the UI)
        "attendees": attendees,
        "meet": meet,
        "attachments": attachments,
        "htmlLink": e.get("htmlLink"),
        "organizer": (e.get("organizer") or {}).get("email"),
        "creator": (e.get("creator") or {}).get("email"),
        "recurring": bool(e.get("recurringEventId")),
        "updated": e.get("updated"),
    }


@app.post("/api/events")
async def create_event(request: Request):
    body = await request.json()
    account = _require(body, "account")
    created = (
        svc(account, "calendar", "v3")
        .events()
        .insert(calendarId=body.get("calendarId", "primary"), body=_event_body(body))
        .execute()
    )
    return {"id": created["id"]}


@app.patch("/api/events/{calendar_id:path}/{event_id}")
async def update_event(calendar_id: str, event_id: str, request: Request):
    body = await request.json()
    account = _require(body, "account")
    svc(account, "calendar", "v3").events().patch(
        calendarId=calendar_id, eventId=event_id, body=_event_body(body)
    ).execute()
    return {"ok": True}


@app.delete("/api/events/{calendar_id:path}/{event_id}")
def delete_event(calendar_id: str, event_id: str, account: str):
    svc(account, "calendar", "v3").events().delete(
        calendarId=calendar_id, eventId=event_id
    ).execute()
    return {"ok": True}


def _event_body(body: dict) -> dict:
    """Translate the front-end payload into a Calendar API event resource."""
    event: dict = {"summary": body.get("summary", "")}
    if body.get("location") is not None:
        event["location"] = body["location"]
    if body.get("description") is not None:
        event["description"] = body["description"]
    if body.get("allDay"):
        # all-day: end date is exclusive in the Calendar API
        event["start"] = {"date": body["start"][:10]}
        event["end"] = {"date": body["end"][:10]}
    else:
        event["start"] = {"dateTime": body["start"]}
        event["end"] = {"dateTime": body["end"]}
    return event


# --------------------------------------------------------------------------- #
# Tasks
# --------------------------------------------------------------------------- #
@app.get("/api/tasklists")
def list_tasklists():
    out = []
    for a in list_accounts():
        try:
            items = (
                svc(a["email"], "tasks", "v1")
                .tasklists()
                .list(maxResults=100)
                .execute()
                .get("items", [])
            )
        except HttpError:
            continue
        for t in items:
            out.append({"account": a["email"], "id": t["id"], "title": t["title"]})
    return out


@app.get("/api/tasks")
def list_tasks(account: str, tasklist: str):
    resp = (
        svc(account, "tasks", "v1")
        .tasks()
        .list(tasklist=tasklist, showCompleted=True, showHidden=True, maxResults=100)
        .execute()
    )
    out = []
    for t in resp.get("items", []):
        out.append(
            {
                "account": account,
                "id": t["id"],
                "title": t.get("title", ""),
                "notes": t.get("notes"),
                "status": t.get("status", "needsAction"),
                "due": t.get("due"),  # RFC3339, date-granularity only
                "position": t.get("position"),
                "parent": t.get("parent"),  # subtask grouping (#3)
            }
        )
    out.sort(key=lambda x: x["position"] or "")
    return out


@app.post("/api/tasks")
async def create_task(request: Request):
    body = await request.json()
    account = _require(body, "account")
    created = (
        svc(account, "tasks", "v1")
        .tasks()
        .insert(tasklist=body["tasklist"], body=_task_body(body))
        .execute()
    )
    return {"id": created["id"]}


@app.patch("/api/tasks/{tasklist}/{task_id}")
async def update_task(tasklist: str, task_id: str, request: Request):
    body = await request.json()
    account = _require(body, "account")
    # status=needsAction by itself clears the completed timestamp server-side.
    svc(account, "tasks", "v1").tasks().patch(
        tasklist=tasklist, task=task_id, body=_task_body(body)
    ).execute()
    return {"ok": True}


@app.delete("/api/tasks/{tasklist}/{task_id}")
def delete_task(tasklist: str, task_id: str, account: str):
    svc(account, "tasks", "v1").tasks().delete(
        tasklist=tasklist, task=task_id
    ).execute()
    return {"ok": True}


def _task_body(body: dict) -> dict:
    out: dict = {}
    if "title" in body:
        out["title"] = body["title"]
    if "notes" in body:
        out["notes"] = body["notes"]
    if "status" in body:
        out["status"] = body["status"]
    if "due" in body:
        # Tasks API stores date granularity only; send midnight UTC or clear.
        # (Confirmed 2026: the API cannot read/write a time-of-day on `due`.)
        if body["due"]:
            out["due"] = body["due"][:10] + "T00:00:00.000Z"
        else:
            out["due"] = None
    return out


def _require(body: dict, key: str):
    if key not in body or body[key] in (None, ""):
        raise HTTPException(status_code=400, detail=f"missing '{key}'")
    return body[key]


# --------------------------------------------------------------------------- #
# Static front-end
# --------------------------------------------------------------------------- #
@app.get("/", response_class=HTMLResponse)
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        # Secure default: loopback only. Put Cloudflare Tunnel (or a reverse
        # proxy) in front for public access. For LAN/Tailscale set HOST=0.0.0.0.
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8765")),
        reload=False,
    )
