from collections import defaultdict
from datetime import datetime, timezone
from io import BytesIO
import json, os, uuid
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, Query, UploadFile, File, Header
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import inspect, select, or_, func, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from PIL import Image, UnidentifiedImageError
from .config import settings
from .db import Base, engine, get_db, SessionLocal
from . import models, schemas
from .security import hash_password, verify_password, create_token, decode_token

Base.metadata.create_all(bind=engine)
with engine.begin() as connection:
    user_columns = {column["name"] for column in inspect(connection).get_columns("users")}
    conversation_columns = {column["name"] for column in inspect(connection).get_columns("conversations")}
    member_columns = {column["name"] for column in inspect(connection).get_columns("conversation_members")}
    message_columns = {column["name"] for column in inspect(connection).get_columns("messages")}
    if "profile_photo_visibility" not in user_columns:
        connection.execute(text(
            "ALTER TABLE users ADD COLUMN profile_photo_visibility VARCHAR(20) NOT NULL DEFAULT 'everyone'"
        ))
    if "about_visibility" not in user_columns:
        connection.execute(text(
            "ALTER TABLE users ADD COLUMN about_visibility VARCHAR(20) NOT NULL DEFAULT 'everyone'"
        ))
    if "description" not in conversation_columns:
        connection.execute(text("ALTER TABLE conversations ADD COLUMN description VARCHAR(500) NOT NULL DEFAULT ''"))
    if "avatar_url" not in conversation_columns:
        connection.execute(text("ALTER TABLE conversations ADD COLUMN avatar_url VARCHAR(255)"))
    if "creator_id" not in conversation_columns:
        connection.execute(text("ALTER TABLE conversations ADD COLUMN creator_id INTEGER"))
    if "creation_key" not in conversation_columns:
        connection.execute(text("ALTER TABLE conversations ADD COLUMN creation_key VARCHAR(36)"))
    if "updated_at" not in conversation_columns:
        connection.execute(text("ALTER TABLE conversations ADD COLUMN updated_at DATETIME"))
        connection.execute(text("UPDATE conversations SET updated_at = created_at WHERE updated_at IS NULL"))
    if "joined_at" not in member_columns:
        connection.execute(text("ALTER TABLE conversation_members ADD COLUMN joined_at DATETIME"))
        connection.execute(text("UPDATE conversation_members SET joined_at = CURRENT_TIMESTAMP WHERE joined_at IS NULL"))
    if engine.dialect.name == "mysql":
        creator_foreign_key = any(
            "creator_id" in key.get("constrained_columns", [])
            for key in inspect(connection).get_foreign_keys("conversations")
        )
        if not creator_foreign_key:
            connection.execute(text(
                "ALTER TABLE conversations ADD CONSTRAINT fk_conversations_creator_id_users "
                "FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL"
            ))
    if "is_system" not in message_columns:
        connection.execute(text("ALTER TABLE messages ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT 0"))
    if "client_nonce" not in message_columns:
        connection.execute(text("ALTER TABLE messages ADD COLUMN client_nonce VARCHAR(36)"))
models.Index("uq_messages_conversation_sender_nonce", models.Message.conversation_id,
             models.Message.sender_id, models.Message.client_nonce, unique=True).create(bind=engine, checkfirst=True)
models.Index("uq_conversations_creator_creation_key", models.Conversation.creator_id,
             models.Conversation.creation_key, unique=True).create(bind=engine, checkfirst=True)
app = FastAPI(title="ChatSphere API", version="1.1.0")
app.add_middleware(CORSMiddleware, allow_origins=[settings.frontend_origin], allow_credentials=True,
                   allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["*"])
connections: dict[int, set[WebSocket]] = defaultdict(set)
UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
AVATAR_DIR = Path(__file__).resolve().parent.parent / "profile_avatars"
AVATAR_DIR.mkdir(exist_ok=True)
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain"}
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_AVATAR_BYTES = 5 * 1024 * 1024

def avatar_path(user: models.User) -> Path | None:
    if not user.avatar_url or Path(user.avatar_url).name != user.avatar_url:
        return None
    return AVATAR_DIR / user.avatar_url

def group_avatar_path(convo: models.Conversation) -> Path | None:
    if not convo.avatar_url or Path(convo.avatar_url).name != convo.avatar_url:
        return None
    return AVATAR_DIR / convo.avatar_url

def user_payload(user: models.User, viewer_id: int, include_settings: bool = False):
    is_self = user.id == viewer_id
    avatar_visible = is_self or user.profile_photo_visibility == "everyone"
    about_visible = is_self or user.about_visibility == "everyone"
    payload = {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "avatar_url": f"/api/users/{user.id}/avatar" if avatar_visible and avatar_path(user) and avatar_path(user).is_file() else None,
        "about": user.about if about_visible else None,
        "about_visible": about_visible,
    }
    if include_settings:
        payload["profile_photo_visibility"] = user.profile_photo_visibility
        payload["about_visibility"] = user.about_visibility
    return payload

def get_current_user(token: str, db: Session):
    user = db.get(models.User, decode_token(token))
    if not user: raise HTTPException(status_code=401, detail="User not found")
    return user

def get_current_user_from_auth(token: str | None, authorization: str | None, db: Session):
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    return get_current_user(token, db)

def is_member(db: Session, cid: int, uid: int) -> bool:
    return db.scalar(select(models.ConversationMember.id).where(
        models.ConversationMember.conversation_id == cid, models.ConversationMember.user_id == uid)) is not None

def conversation_payload(db: Session, convo: models.Conversation, viewer_id: int | None = None):
    memberships = db.execute(select(models.User, models.ConversationMember).join(models.ConversationMember,
        models.ConversationMember.user_id == models.User.id).where(models.ConversationMember.conversation_id == convo.id)).all()
    last = db.scalar(select(models.Message).where(models.Message.conversation_id == convo.id)
        .order_by(models.Message.created_at.desc(), models.Message.id.desc()).limit(1))
    viewer_member = db.scalar(select(models.ConversationMember).where(
        models.ConversationMember.conversation_id == convo.id, models.ConversationMember.user_id == viewer_id)) if viewer_id else None
    unread_count = 0
    if viewer_member:
        unread_count = db.scalar(select(func.count(models.Message.id)).where(
            models.Message.conversation_id == convo.id,
            models.Message.sender_id != viewer_id,
            models.Message.id > (viewer_member.last_read_message_id or 0)
        )) or 0
    members_out = []
    for member_user, membership in memberships:
        item = user_payload(member_user, viewer_id)
        item["is_admin"] = membership.is_admin
        members_out.append(item)
    return {"id": convo.id, "title": convo.title, "is_group": convo.is_group,
        "description": convo.description or "",
        "avatar_url": f"/api/conversations/{convo.id}/avatar" if group_avatar_path(convo) and group_avatar_path(convo).is_file() else None,
        "creator_id": convo.creator_id,
        "member_count": len(members_out),
        "is_admin": viewer_member.is_admin if viewer_member else False,
        "unread_count": unread_count,
        "created_at": convo.created_at.isoformat(),
        "updated_at": convo.updated_at.isoformat() if convo.updated_at else convo.created_at.isoformat(),
        "is_archived": viewer_member.is_archived if viewer_member else False,
        "is_muted": viewer_member.is_muted if viewer_member else False,
        "members": members_out,
        "last_message": {"body": last.body, "created_at": last.created_at.isoformat(), "sender_id": last.sender_id,
            "attachment_name": last.attachment_name} if last and not last.deleted_at else ({"body": "Message deleted", "created_at": last.created_at.isoformat(), "sender_id": last.sender_id} if last else None)}

async def broadcast(event: dict, recipients=None):
    targets = list(connections.keys()) if recipients is None else recipients
    for uid in targets:
        for ws in list(connections.get(uid, set())):
            try: await ws.send_json(event)
            except Exception: connections[uid].discard(ws)

@app.get("/health")
def health(): return {"status": "ok"}

@app.post("/api/auth/register", response_model=schemas.AuthOut)
def register(data: schemas.RegisterIn, db: Session = Depends(get_db)):
    username = data.username.lower()
    if db.scalar(select(models.User).where(models.User.username == username)):
        raise HTTPException(status_code=409, detail="Username already exists")
    user = models.User(username=username, display_name=data.display_name.strip(), password_hash=hash_password(data.password))
    db.add(user); db.commit(); db.refresh(user)
    return {"access_token": create_token(user.id), "user": user_payload(user, user.id)}

@app.post("/api/auth/login", response_model=schemas.AuthOut)
def login(data: schemas.LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(models.User).where(models.User.username == data.username.lower()))
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    return {"access_token": create_token(user.id), "user": user_payload(user, user.id)}

@app.get("/api/me", response_model=schemas.MyProfileOut)
def me(token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    return user_payload(user, user.id, include_settings=True)

@app.patch("/api/me", response_model=schemas.MyProfileOut)
def update_me(data: schemas.ProfileIn, token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    changes = data.model_dump(exclude_unset=True)
    if "display_name" in changes:
        display_name = (changes["display_name"] or "").strip()
        if not display_name:
            raise HTTPException(status_code=422, detail="Display name cannot be empty")
        user.display_name = display_name
    if "username" in changes:
        username = (changes["username"] or "").strip().lower()
        if not username:
            raise HTTPException(status_code=422, detail="Username cannot be empty")
        duplicate = db.scalar(select(models.User.id).where(
            models.User.username == username, models.User.id != user.id
        ))
        if duplicate:
            raise HTTPException(status_code=409, detail="Username already exists")
        user.username = username
    if "about" in changes:
        user.about = (changes["about"] or "").strip()
    if "profile_photo_visibility" in changes and changes["profile_photo_visibility"] is not None:
        user.profile_photo_visibility = changes["profile_photo_visibility"]
    if "about_visibility" in changes and changes["about_visibility"] is not None:
        user.about_visibility = changes["about_visibility"]
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Username already exists")
    db.refresh(user)
    return user_payload(user, user.id, include_settings=True)

@app.get("/api/users", response_model=list[schemas.UserOut])
def users(search: str = "", token: str = Query(...), db: Session = Depends(get_db)):
    me_user = get_current_user(token, db); stmt = select(models.User).where(models.User.id != me_user.id)
    if search.strip():
        needle = search.strip().replace("%", r"\%").replace("_", r"\_")
        stmt = stmt.where(or_(
            models.User.username.ilike(f"%{needle}%", escape="\\"),
            models.User.display_name.ilike(f"%{needle}%", escape="\\"),
        ))
    return [user_payload(user, me_user.id) for user in db.scalars(
        stmt.order_by(models.User.display_name).limit(50)
    ).all()]

@app.get("/api/users/{user_id}/profile", response_model=schemas.UserOut)
def user_profile(user_id: int, token: str = Query(...), db: Session = Depends(get_db)):
    viewer = get_current_user(token, db)
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user_payload(user, viewer.id)

@app.get("/api/users/{user_id}/avatar")
def get_avatar(user_id: int, token: str | None = Query(None), authorization: str | None = Header(None),
               db: Session = Depends(get_db)):
    viewer = get_current_user_from_auth(token, authorization, db)
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if viewer.id != user.id and user.profile_photo_visibility != "everyone":
        raise HTTPException(status_code=404, detail="Profile photo not found")
    path = avatar_path(user)
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="Profile photo not found")
    return FileResponse(path, headers={"Cache-Control": "private, no-store"})

def detect_avatar_type(content: bytes) -> tuple[str, str] | None:
    if content.startswith(b"\xff\xd8\xff") and content.endswith(b"\xff\xd9"):
        return "image/jpeg", ".jpg"
    if content.startswith(b"\x89PNG\r\n\x1a\n") and len(content) >= 24:
        return "image/png", ".png"
    if content.startswith((b"GIF87a", b"GIF89a")) and len(content) >= 10:
        return "image/gif", ".gif"
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None

@app.post("/api/me/avatar", response_model=schemas.MyProfileOut)
async def upload_avatar(token: str = Query(...), file: UploadFile = File(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    content = await file.read(MAX_AVATAR_BYTES + 1)
    if len(content) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Profile photos must be 5 MB or smaller")
    detected = detect_avatar_type(content)
    if not detected or file.content_type != detected[0]:
        raise HTTPException(status_code=415, detail="Choose a valid JPEG, PNG, WebP, or GIF image")
    expected_format = {
        "image/jpeg": "JPEG",
        "image/png": "PNG",
        "image/webp": "WEBP",
        "image/gif": "GIF",
    }[detected[0]]
    try:
        with Image.open(BytesIO(content)) as image:
            if image.format != expected_format:
                raise HTTPException(status_code=415, detail="Image content does not match its file type")
            if image.width * image.height > 20_000_000:
                raise HTTPException(status_code=413, detail="Profile photo dimensions are too large")
            image.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=415, detail="The uploaded file is not a valid image") from exc
    extension = detected[1]
    filename = f"{uuid.uuid4().hex}{extension}"
    target = AVATAR_DIR / filename
    target.write_bytes(content)
    old_path = avatar_path(user)
    user.avatar_url = filename
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        target.unlink(missing_ok=True)
        raise
    db.refresh(user)
    if old_path and old_path != target:
        old_path.unlink(missing_ok=True)
    return user_payload(user, user.id, include_settings=True)

@app.delete("/api/me/avatar", response_model=schemas.MyProfileOut)
def delete_avatar(token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    old_path = avatar_path(user)
    user.avatar_url = None
    db.commit()
    db.refresh(user)
    if old_path:
        old_path.unlink(missing_ok=True)
    return user_payload(user, user.id, include_settings=True)

def group_member(db: Session, cid: int, uid: int) -> models.ConversationMember:
    member = db.scalar(select(models.ConversationMember).where(
        models.ConversationMember.conversation_id == cid,
        models.ConversationMember.user_id == uid
    ))
    if not member:
        raise HTTPException(status_code=403, detail="Not a conversation member")
    return member

def require_group_admin(db: Session, cid: int, uid: int, lock: bool = False):
    stmt = select(models.Conversation).where(models.Conversation.id == cid)
    if lock:
        stmt = stmt.with_for_update()
    convo = db.scalar(stmt)
    if not convo or not convo.is_group:
        raise HTTPException(status_code=404, detail="Group not found")
    member = group_member(db, cid, uid)
    if not member.is_admin:
        raise HTTPException(status_code=403, detail="Group admin permission required")
    return convo, member

def add_system_event(db: Session, cid: int, actor_id: int, body: str):
    db.add(models.Message(conversation_id=cid, sender_id=actor_id, body=body, is_system=True))

def group_recipients(db: Session, cid: int) -> list[int]:
    return db.scalars(select(models.ConversationMember.user_id).where(
        models.ConversationMember.conversation_id == cid
    )).all()

@app.post("/api/conversations")
async def create_conversation(data: schemas.ConversationIn, token: str = Query(...),
                              idempotency_key: str | None = Header(None), db: Session = Depends(get_db)):
    me_user = get_current_user(token, db)
    member_ids = sorted(set(data.member_ids + [me_user.id]))
    is_group = data.is_group or len(member_ids) > 2
    if idempotency_key and is_group:
        try:
            uuid.UUID(idempotency_key)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Idempotency-Key must be a UUID") from exc
        previous = db.scalar(select(models.Conversation).where(
            models.Conversation.creator_id == me_user.id,
            models.Conversation.creation_key == idempotency_key
        ))
        if previous:
            return conversation_payload(db, previous, me_user.id)
    found = set(db.scalars(select(models.User.id).where(models.User.id.in_(member_ids))).all())
    if found != set(member_ids): raise HTTPException(status_code=400, detail="One or more users do not exist")
    title = (data.title or "").strip()
    if data.is_group and len(member_ids) < 3:
        raise HTTPException(status_code=422, detail="Choose at least two other members for a group")
    if data.is_group and not title:
        raise HTTPException(status_code=422, detail="A group name is required")
    if not is_group and not data.title:
        existing = db.execute(select(models.Conversation.id).join(models.ConversationMember,
            models.ConversationMember.conversation_id == models.Conversation.id).where(
            models.ConversationMember.user_id.in_(member_ids)).group_by(models.Conversation.id).having(
            func.count(models.ConversationMember.user_id) == 2)).first()
        if existing: return conversation_payload(db, db.get(models.Conversation, existing[0]), me_user.id)
    convo = models.Conversation(
        title=title or None, is_group=is_group, description=data.description.strip(),
        creator_id=me_user.id if is_group else None,
        creation_key=idempotency_key if is_group else None
    ); db.add(convo); db.flush()
    for uid in member_ids: db.add(models.ConversationMember(conversation_id=convo.id, user_id=uid, is_admin=(uid == me_user.id)))
    if is_group:
        add_system_event(db, convo.id, me_user.id, f"{me_user.display_name or me_user.username} created the group")
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if is_group and idempotency_key:
            previous = db.scalar(select(models.Conversation).where(
                models.Conversation.creator_id == me_user.id,
                models.Conversation.creation_key == idempotency_key
            ))
            if previous:
                return conversation_payload(db, previous, me_user.id)
        raise HTTPException(status_code=409, detail="Could not create the conversation with this request key") from exc
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=500, detail="Could not create the conversation")
    db.refresh(convo)
    payload = conversation_payload(db, convo, me_user.id)
    if is_group:
        await broadcast({"type": "group_updated", "conversation_id": convo.id}, member_ids)
    return payload

@app.get("/api/conversations")
def list_conversations(token: str = Query(...), include_archived: bool = False, db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    memberships = db.scalars(select(models.ConversationMember).where(models.ConversationMember.user_id == user.id)).all()
    payload = []
    for membership in memberships:
        if membership.is_archived and not include_archived: continue
        convo = db.get(models.Conversation, membership.conversation_id)
        if convo: payload.append(conversation_payload(db, convo, user.id))
    return sorted(payload, key=lambda c: c["last_message"]["created_at"] if c["last_message"] else c["created_at"], reverse=True)

@app.get("/api/conversations/{cid}")
def get_conversation(cid: int, token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    if not is_member(db, cid, user.id):
        raise HTTPException(status_code=403, detail="Not a conversation member")
    convo = db.get(models.Conversation, cid)
    if not convo:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation_payload(db, convo, user.id)

@app.patch("/api/conversations/{cid}/group")
async def update_group(cid: int, data: schemas.GroupUpdateIn, token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    convo, _ = require_group_admin(db, cid, user.id, lock=True)
    changes = data.model_dump(exclude_unset=True)
    if not changes:
        return conversation_payload(db, convo, user.id)
    events = []
    if "title" in changes:
        title = (changes["title"] or "").strip()
        if not title:
            raise HTTPException(status_code=422, detail="A group name is required")
        if title != convo.title:
            convo.title = title
            events.append(f"{user.display_name or user.username} changed the group name")
    if "description" in changes:
        description = (changes["description"] or "").strip()
        if description != convo.description:
            convo.description = description
            events.append(f"{user.display_name or user.username} updated the group description")
    convo.updated_at = datetime.now(timezone.utc)
    for event in events:
        add_system_event(db, cid, user.id, event)
    db.commit()
    db.refresh(convo)
    await broadcast({"type": "group_updated", "conversation_id": cid}, group_recipients(db, cid))
    return conversation_payload(db, convo, user.id)

@app.post("/api/conversations/{cid}/members")
async def add_group_members(cid: int, data: schemas.GroupMembersIn, token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    convo, _ = require_group_admin(db, cid, user.id, lock=True)
    member_ids = set(data.member_ids)
    if user.id in member_ids:
        raise HTTPException(status_code=422, detail="You are already a group member")
    found = set(db.scalars(select(models.User.id).where(models.User.id.in_(member_ids))).all())
    if found != member_ids:
        raise HTTPException(status_code=400, detail="One or more users do not exist")
    existing = set(db.scalars(select(models.ConversationMember.user_id).where(
        models.ConversationMember.conversation_id == cid,
        models.ConversationMember.user_id.in_(member_ids)
    )).all())
    if existing:
        raise HTTPException(status_code=409, detail="One or more users are already group members")
    new_members = sorted(member_ids)
    for uid in new_members:
        db.add(models.ConversationMember(conversation_id=cid, user_id=uid, is_admin=False))
        invited = db.get(models.User, uid)
        add_system_event(db, cid, user.id, f"{user.display_name or user.username} added {invited.display_name or invited.username}")
    convo.updated_at = datetime.now(timezone.utc)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="A group membership changed at the same time") from exc
    await broadcast({"type": "group_updated", "conversation_id": cid}, group_recipients(db, cid))
    return conversation_payload(db, convo, user.id)

@app.delete("/api/conversations/{cid}/members/{member_id}")
async def remove_group_member(cid: int, member_id: int, token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    convo = db.scalar(select(models.Conversation).where(
        models.Conversation.id == cid
    ).with_for_update())
    if not convo or not convo.is_group:
        raise HTTPException(status_code=404, detail="Group not found")
    actor_membership = group_member(db, cid, user.id)
    target = db.scalar(select(models.ConversationMember).where(
        models.ConversationMember.conversation_id == cid,
        models.ConversationMember.user_id == member_id
    ))
    if not target:
        raise HTTPException(status_code=404, detail="Group member not found")
    if member_id != user.id and not actor_membership.is_admin:
        raise HTTPException(status_code=403, detail="Group admin permission required")
    if member_id == user.id:
        return await leave_group(cid, token, db, user, convo, target)
    if target.is_admin:
        admin_count = db.scalar(select(func.count(models.ConversationMember.id)).where(
            models.ConversationMember.conversation_id == cid,
            models.ConversationMember.is_admin.is_(True)
        )) or 0
        if admin_count <= 1:
            raise HTTPException(status_code=409, detail="The last group admin cannot be removed")
    target_user = db.get(models.User, member_id)
    db.delete(target)
    add_system_event(db, cid, user.id, f"{user.display_name or user.username} removed {target_user.display_name or target_user.username}")
    convo.updated_at = datetime.now(timezone.utc)
    db.commit()
    recipients = group_recipients(db, cid)
    await broadcast({"type": "group_updated", "conversation_id": cid}, recipients)
    await broadcast({"type": "membership_revoked", "conversation_id": cid}, [member_id])
    return conversation_payload(db, convo, user.id)

@app.post("/api/conversations/{cid}/avatar")
async def upload_group_avatar(cid: int, token: str = Query(...), file: UploadFile = File(...),
                              db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    convo, _ = require_group_admin(db, cid, user.id, lock=True)
    content = await file.read(MAX_AVATAR_BYTES + 1)
    if len(content) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Group photos must be 5 MB or smaller")
    detected = detect_avatar_type(content)
    if not detected or file.content_type != detected[0]:
        raise HTTPException(status_code=415, detail="Choose a valid JPEG, PNG, WebP, or GIF image")
    expected_format = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP", "image/gif": "GIF"}[detected[0]]
    try:
        with Image.open(BytesIO(content)) as image:
            if image.format != expected_format:
                raise HTTPException(status_code=415, detail="Image content does not match its file type")
            if image.width * image.height > 20_000_000:
                raise HTTPException(status_code=413, detail="Group photo dimensions are too large")
            image.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=415, detail="The uploaded file is not a valid image") from exc
    filename = f"{uuid.uuid4().hex}{detected[1]}"
    target = AVATAR_DIR / filename
    target.write_bytes(content)
    old_path = group_avatar_path(convo)
    convo.avatar_url = filename
    convo.updated_at = datetime.now(timezone.utc)
    add_system_event(db, cid, user.id, f"{user.display_name or user.username} changed the group photo")
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not update the group photo")
    if old_path and old_path != target:
        old_path.unlink(missing_ok=True)
    await broadcast({"type": "group_updated", "conversation_id": cid}, group_recipients(db, cid))
    return conversation_payload(db, convo, user.id)

@app.get("/api/conversations/{cid}/avatar")
def get_group_avatar(cid: int, token: str | None = Query(None), authorization: str | None = Header(None),
                     db: Session = Depends(get_db)):
    user = get_current_user_from_auth(token, authorization, db)
    if not is_member(db, cid, user.id):
        raise HTTPException(status_code=403, detail="Not a conversation member")
    convo = db.get(models.Conversation, cid)
    path = group_avatar_path(convo) if convo and convo.is_group else None
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="Group photo not found")
    return FileResponse(path, headers={"Cache-Control": "private, no-store"})

async def leave_group(cid: int, token: str, db: Session, user: models.User,
                      convo: models.Conversation, membership: models.ConversationMember):
    if membership.is_admin:
        admins = db.scalar(select(func.count(models.ConversationMember.id)).where(
            models.ConversationMember.conversation_id == cid,
            models.ConversationMember.is_admin.is_(True)
        )) or 0
        if admins <= 1:
            successor = db.scalar(select(models.ConversationMember).where(
                models.ConversationMember.conversation_id == cid,
                models.ConversationMember.user_id != user.id
            ).order_by(models.ConversationMember.joined_at, models.ConversationMember.id).limit(1).with_for_update())
            if not successor:
                raise HTTPException(status_code=409, detail="Add another member before leaving as the last admin")
            successor.is_admin = True
            successor_user = db.get(models.User, successor.user_id)
            add_system_event(db, cid, user.id, f"{successor_user.display_name or successor_user.username} is now a group admin")
    db.delete(membership)
    add_system_event(db, cid, user.id, f"{user.display_name or user.username} left the group")
    convo.updated_at = datetime.now(timezone.utc)
    db.commit()
    recipients = group_recipients(db, cid)
    await broadcast({"type": "group_updated", "conversation_id": cid}, recipients)
    await broadcast({"type": "membership_revoked", "conversation_id": cid}, [user.id])
    return {"ok": True}

@app.put("/api/conversations/{cid}/members/{member_id}/role")
async def update_group_role(cid: int, member_id: int, data: schemas.GroupRoleIn,
                            token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    convo, _ = require_group_admin(db, cid, user.id, lock=True)
    target = db.scalar(select(models.ConversationMember).where(
        models.ConversationMember.conversation_id == cid,
        models.ConversationMember.user_id == member_id
    ))
    if not target:
        raise HTTPException(status_code=404, detail="Group member not found")
    if target.is_admin and not data.is_admin:
        admin_count = db.scalar(select(func.count(models.ConversationMember.id)).where(
            models.ConversationMember.conversation_id == cid,
            models.ConversationMember.is_admin.is_(True)
        )) or 0
        if admin_count <= 1:
            raise HTTPException(status_code=409, detail="The last group admin cannot be demoted")
    if target.is_admin != data.is_admin:
        target.is_admin = data.is_admin
        target_user = db.get(models.User, member_id)
        action = "promoted" if data.is_admin else "removed as admin"
        add_system_event(db, cid, user.id, f"{target_user.display_name or target_user.username} was {action}")
        convo.updated_at = datetime.now(timezone.utc)
        db.commit()
        await broadcast({"type": "group_updated", "conversation_id": cid}, group_recipients(db, cid))
    return conversation_payload(db, convo, user.id)

@app.patch("/api/conversations/{cid}/settings")
def conversation_settings(cid: int, archived: bool | None = None, muted: bool | None = None,
                          token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    member = db.scalar(select(models.ConversationMember).where(models.ConversationMember.conversation_id == cid,
        models.ConversationMember.user_id == user.id))
    if not member: raise HTTPException(status_code=403, detail="Not a conversation member")
    if archived is not None: member.is_archived = archived
    if muted is not None: member.is_muted = muted
    db.commit(); return {"ok": True, "is_archived": member.is_archived, "is_muted": member.is_muted}

@app.get("/api/conversations/{cid}/messages", response_model=list[schemas.MessageOut])
def get_messages(cid: int, token: str = Query(...), limit: int = Query(100, ge=1, le=200),
                 before_id: int | None = Query(None, gt=0), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    if not is_member(db, cid, user.id): raise HTTPException(status_code=403, detail="Not a conversation member")
    stmt = select(models.Message).where(models.Message.conversation_id == cid)
    if before_id is not None:
        stmt = stmt.where(models.Message.id < before_id)
    stmt = stmt.order_by(models.Message.id.desc()).limit(limit)
    return list(reversed(db.scalars(stmt).all()))

@app.patch("/api/messages/{message_id}", response_model=schemas.MessageOut)
def edit_message(message_id: int, data: schemas.MessageEditIn, token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db); msg = db.get(models.Message, message_id)
    if not msg or not is_member(db, msg.conversation_id, user.id): raise HTTPException(status_code=404, detail="Message not found")
    if msg.sender_id != user.id: raise HTTPException(status_code=403, detail="You can only edit your own messages")
    if msg.deleted_at: raise HTTPException(status_code=400, detail="Deleted messages cannot be edited")
    msg.body = data.body.strip(); msg.edited_at = datetime.now(timezone.utc); db.commit(); db.refresh(msg)
    payload = {"type":"message_updated","message":{"id":msg.id,"conversation_id":msg.conversation_id,"sender_id":msg.sender_id,"body":msg.body,"created_at":msg.created_at.isoformat(),"edited_at":msg.edited_at.isoformat()}}
    member_ids = db.scalars(select(models.ConversationMember.user_id).where(models.ConversationMember.conversation_id == msg.conversation_id)).all()
    import asyncio
    try: asyncio.get_running_loop().create_task(broadcast(payload, member_ids))
    except RuntimeError: pass
    return msg

@app.delete("/api/messages/{message_id}")
async def delete_message(message_id: int, token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db); msg = db.get(models.Message, message_id)
    if not msg or not is_member(db, msg.conversation_id, user.id): raise HTTPException(status_code=404, detail="Message not found")
    if msg.sender_id != user.id: raise HTTPException(status_code=403, detail="You can only delete your own messages")
    msg.body = ""; msg.attachment_url = None; msg.deleted_at = datetime.now(timezone.utc); db.commit()
    members = db.scalars(select(models.ConversationMember.user_id).where(models.ConversationMember.conversation_id == msg.conversation_id)).all()
    await broadcast({"type":"message_deleted","message_id":msg.id,"conversation_id":msg.conversation_id}, members)
    return {"ok": True}

@app.post("/api/messages/{message_id}/reactions")
def toggle_reaction(message_id: int, data: schemas.ReactionIn, token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db); msg = db.get(models.Message, message_id)
    if not msg or not is_member(db, msg.conversation_id, user.id): raise HTTPException(status_code=404, detail="Message not found")
    existing = db.scalar(select(models.MessageReaction).where(models.MessageReaction.message_id == message_id,
        models.MessageReaction.user_id == user.id, models.MessageReaction.emoji == data.emoji))
    if existing: db.delete(existing); active = False
    else: db.add(models.MessageReaction(message_id=message_id, user_id=user.id, emoji=data.emoji)); active = True
    db.commit()
    return {"ok": True, "active": active}

@app.post("/api/conversations/{cid}/read")
def mark_read(cid: int, token: str = Query(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    member = db.scalar(select(models.ConversationMember).where(models.ConversationMember.conversation_id == cid,
        models.ConversationMember.user_id == user.id))
    if not member: raise HTTPException(status_code=403, detail="Not a conversation member")
    last = db.scalar(select(models.Message).where(models.Message.conversation_id == cid).order_by(
        models.Message.id.desc()).limit(1))
    member.last_read_message_id = last.id if last else None; db.commit()
    return {"ok": True, "last_read_message_id": member.last_read_message_id}

@app.post("/api/uploads")
async def upload(token: str = Query(...), file: UploadFile = File(...), db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    if file.content_type not in ALLOWED_MIME: raise HTTPException(status_code=415, detail="File type not allowed")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES: raise HTTPException(status_code=413, detail="Maximum upload size is 8 MB")
    suffix = Path(file.filename or "upload").suffix[:12]
    name = f"{uuid.uuid4().hex}{suffix}"
    (UPLOAD_DIR / name).write_bytes(content)
    # Local development storage only. Use private object storage in production.
    return {"url": f"/uploads/{name}", "name": (file.filename or name)[:255], "content_type": file.content_type, "size": len(content)}

@app.get("/api/messages/{message_id}/attachment")
def get_message_attachment(message_id: int, token: str | None = Query(None),
                           authorization: str | None = Header(None), db: Session = Depends(get_db)):
    user = get_current_user_from_auth(token, authorization, db)
    message = db.get(models.Message, message_id)
    if not message or not message.attachment_url or not is_member(db, message.conversation_id, user.id):
        raise HTTPException(status_code=404, detail="Attachment not found")
    filename = Path(message.attachment_url).name
    if message.attachment_url != f"/uploads/{filename}":
        raise HTTPException(status_code=404, detail="Attachment not found")
    path = UPLOAD_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Attachment not found")
    return FileResponse(path, headers={"Cache-Control": "private, no-store"})

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    try: user_id = decode_token(token)
    except HTTPException:
        await websocket.close(code=1008); return
    db = SessionLocal()
    try:
        if not db.get(models.User, user_id): await websocket.close(code=1008); return
    finally: db.close()
    await websocket.accept(); connections[user_id].add(websocket)
    await broadcast({"type":"presence","user_id":user_id,"online":True})
    try:
        while True:
            try:
                event = json.loads(await websocket.receive_text())
                event_type = event.get("type", "message")
                cid = int(event["conversation_id"])
            except (ValueError, KeyError, TypeError, json.JSONDecodeError): continue
            db = SessionLocal()
            try:
                if not is_member(db, cid, user_id):
                    await websocket.send_json({"type":"error","detail":"Not a conversation member"}); continue
                member_ids = db.scalars(select(models.ConversationMember.user_id).where(models.ConversationMember.conversation_id == cid)).all()
                if event_type == "typing":
                    out = {"type":"typing","conversation_id":cid,"user_id":user_id,"is_typing":bool(event.get("is_typing",True))}
                elif event_type == "message":
                    body = str(event.get("body","")).strip()
                    attachment_url = event.get("attachment_url")
                    attachment_name = event.get("attachment_name")
                    attachment_type = event.get("attachment_type")
                    client_nonce = event.get("client_nonce")
                    if (not body and not attachment_url) or len(body) > 5000: continue
                    if attachment_url:
                        filename = Path(str(attachment_url)).name
                        if str(attachment_url) != f"/uploads/{filename}" or not (UPLOAD_DIR / filename).is_file():
                            await websocket.send_json({"type": "error", "detail": "Attachment not found"})
                            continue
                    if client_nonce is not None and (not isinstance(client_nonce, str) or len(client_nonce) != 36): continue
                    if client_nonce:
                        existing = db.scalar(select(models.Message).where(
                            models.Message.conversation_id == cid,
                            models.Message.sender_id == user_id,
                            models.Message.client_nonce == client_nonce
                        ))
                        if existing:
                            out = {"type":"message","message":{"id":existing.id,"conversation_id":cid,"sender_id":user_id,
                                "body":existing.body,"attachment_url":existing.attachment_url,"attachment_name":existing.attachment_name,
                                "attachment_type":existing.attachment_type,"created_at":existing.created_at.isoformat(),
                                "edited_at":existing.edited_at.isoformat() if existing.edited_at else None,
                                "client_nonce":existing.client_nonce}}
                            continue_broadcast = True
                        else:
                            continue_broadcast = False
                    else:
                        continue_broadcast = False
                    if continue_broadcast:
                        pass
                    else:
                        msg = models.Message(conversation_id=cid, sender_id=user_id, body=body,
                            attachment_url=attachment_url, attachment_name=attachment_name, attachment_type=attachment_type,
                            client_nonce=client_nonce)
                        db.add(msg)
                        try:
                            db.commit(); db.refresh(msg)
                        except IntegrityError:
                            db.rollback()
                            if not client_nonce:
                                raise
                            msg = db.scalar(select(models.Message).where(
                                models.Message.conversation_id == cid, models.Message.sender_id == user_id,
                                models.Message.client_nonce == client_nonce))
                            if not msg:
                                raise
                        out = {"type":"message","message":{"id":msg.id,"conversation_id":cid,"sender_id":user_id,
                            "body":msg.body,"attachment_url":msg.attachment_url,"attachment_name":msg.attachment_name,
                            "attachment_type":msg.attachment_type,"created_at":msg.created_at.isoformat(),
                            "edited_at":msg.edited_at.isoformat() if msg.edited_at else None,
                            "client_nonce":msg.client_nonce}}
                elif event_type == "read":
                    member = db.scalar(select(models.ConversationMember).where(models.ConversationMember.conversation_id == cid,
                        models.ConversationMember.user_id == user_id))
                    member.last_read_message_id = int(event.get("message_id",0)) or None; db.commit()
                    out = {"type":"read","conversation_id":cid,"user_id":user_id,"message_id":member.last_read_message_id}
                else: continue
            finally: db.close()
            await broadcast(out, member_ids)
    except WebSocketDisconnect: pass
    finally:
        connections[user_id].discard(websocket)
        if not connections[user_id]:
            connections.pop(user_id, None)
            await broadcast({"type":"presence","user_id":user_id,"online":False})
