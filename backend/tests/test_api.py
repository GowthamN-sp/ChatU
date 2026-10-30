import os
import uuid
import asyncio
import json
from io import BytesIO
from PIL import Image
os.environ.setdefault("DATABASE_URL", "sqlite:///./test_chatsphere.db")
os.environ.setdefault("JWT_SECRET", "test-secret-for-chatsphere-suite-2026")
from fastapi.testclient import TestClient
from fastapi import WebSocketDisconnect
from app.db import SessionLocal
from app.main import app, get_message_attachment, remove_group_member, websocket_endpoint

client = TestClient(app)

def make_user(username):
    response = client.post("/api/auth/register", json={
        "username": username, "display_name": username.title(), "password": "test-password-123"
    })
    return response

def test_health():
    assert client.get("/health").json() == {"status": "ok"}

def test_register_login_and_duplicate():
    username = f"testuser_{uuid.uuid4().hex[:8]}"
    first = make_user(username)
    assert first.status_code == 200
    assert "access_token" in first.json()
    duplicate = make_user(username)
    assert duplicate.status_code == 409
    login = client.post("/api/auth/login", json={"username": username, "password": "test-password-123"})
    assert login.status_code == 200

def test_conversation_membership_and_history():
    suffix = uuid.uuid4().hex[:8]
    a = make_user(f"alpha_{suffix}")
    b = make_user(f"beta_{suffix}")
    assert a.status_code == 200 and b.status_code == 200
    token_a = a.json()["access_token"]
    token_b = b.json()["access_token"]
    user_b = b.json()["user"]
    created = client.post(f"/api/conversations?token={token_a}", json={"member_ids": [user_b["id"]]})
    assert created.status_code == 200
    conversation_id = created.json()["id"]
    history = client.get(f"/api/conversations/{conversation_id}/messages?token={token_a}")
    assert history.status_code == 200 and history.json() == []
    stranger = make_user(f"stranger_{suffix}")
    token_stranger = stranger.json()["access_token"]
    forbidden = client.get(f"/api/conversations/{conversation_id}/messages?token={token_stranger}")
    assert forbidden.status_code == 403

def test_profile_edit_avatar_upload_and_privacy():
    suffix = uuid.uuid4().hex[:8]
    first = make_user(f"profile_{suffix}")
    second = make_user(f"viewer_{suffix}")
    assert first.status_code == 200 and second.status_code == 200
    token = first.json()["access_token"]
    viewer_token = second.json()["access_token"]
    user_id = first.json()["user"]["id"]

    edited = client.patch(f"/api/me?token={token}", json={
        "display_name": "Profile Owner",
        "username": f"renamed_{suffix}",
        "about": "A little hello",
    })
    assert edited.status_code == 200
    assert edited.json()["display_name"] == "Profile Owner"
    assert edited.json()["username"] == f"renamed_{suffix}"
    assert client.get(f"/api/me?token={token}").json()["about"] == "A little hello"

    image_buffer = BytesIO()
    Image.new("RGB", (2, 2), color="orange").save(image_buffer, format="PNG")
    image = image_buffer.getvalue()
    invalid = client.post(
        f"/api/me/avatar?token={token}",
        files={"file": ("avatar.png", b"not an image", "image/png")},
    )
    assert invalid.status_code == 415
    uploaded = client.post(
        f"/api/me/avatar?token={token}",
        files={"file": ("avatar.png", image, "image/png")},
    )
    assert uploaded.status_code == 200
    avatar_url = uploaded.json()["avatar_url"]
    assert avatar_url == f"/api/users/{user_id}/avatar"
    assert client.get(f"http://testserver{avatar_url}?token={viewer_token}").status_code == 200

    private = client.patch(f"/api/me?token={token}", json={
        "profile_photo_visibility": "nobody",
        "about_visibility": "nobody",
    })
    assert private.status_code == 200
    other_profile = client.get(f"/api/users/{user_id}/profile?token={viewer_token}")
    assert other_profile.status_code == 200
    assert other_profile.json()["avatar_url"] is None
    assert other_profile.json()["about"] is None
    assert other_profile.json()["about_visible"] is False
    assert client.get(f"http://testserver{avatar_url}?token={viewer_token}").status_code == 404
    assert client.get(f"http://testserver{avatar_url}?token={token}").status_code == 200
    people = client.get(f"/api/users?search=renamed_{suffix}&token={viewer_token}").json()
    listed_profile = next(person for person in people if person["id"] == user_id)
    assert listed_profile["avatar_url"] is None and listed_profile["about"] is None
    client.post(f"/api/conversations?token={viewer_token}", json={"member_ids": [user_id]})
    chats = client.get(f"/api/conversations?token={viewer_token}").json()
    conversation_profile = next(member for member in chats[0]["members"] if member["id"] == user_id)
    assert conversation_profile["avatar_url"] is None and conversation_profile["about"] is None

    removed = client.delete(f"/api/me/avatar?token={token}")
    assert removed.status_code == 200
    assert removed.json()["avatar_url"] is None
    assert client.get(f"http://testserver{avatar_url}?token={token}").status_code == 404

def test_profile_username_must_be_unique():
    suffix = uuid.uuid4().hex[:8]
    first = make_user(f"first_{suffix}")
    second = make_user(f"second_{suffix}")
    assert first.status_code == 200 and second.status_code == 200
    response = client.patch(
        f"/api/me?token={second.json()['access_token']}",
        json={"username": first.json()["user"]["username"]},
    )
    assert response.status_code == 409

def test_group_creation_membership_permissions_and_history():
    suffix = uuid.uuid4().hex[:8]
    owner = make_user(f"group_owner_{suffix}")
    member = make_user(f"group_member_{suffix}")
    invited = make_user(f"group_invited_{suffix}")
    late_member = make_user(f"group_late_{suffix}")
    outsider = make_user(f"group_outsider_{suffix}")
    assert all(response.status_code == 200 for response in [owner, member, invited, late_member, outsider])
    owner_token = owner.json()["access_token"]
    member_token = member.json()["access_token"]
    invited_token = invited.json()["access_token"]
    outsider_token = outsider.json()["access_token"]
    owner_id = owner.json()["user"]["id"]
    member_id = member.json()["user"]["id"]
    invited_id = invited.json()["user"]["id"]
    late_member_id = late_member.json()["user"]["id"]

    creation_key = str(uuid.uuid4())
    group_request = {
        "member_ids": [member_id, invited_id, member_id, owner_id],
        "title": "Project friends",
        "description": "Planning together",
        "is_group": True,
    }
    created = client.post(f"/api/conversations?token={owner_token}", json=group_request,
                          headers={"Idempotency-Key": creation_key})
    assert created.status_code == 200
    group = created.json()
    group_id = group["id"]
    retried = client.post(f"/api/conversations?token={owner_token}", json=group_request,
                          headers={"Idempotency-Key": creation_key})
    assert retried.status_code == 200 and retried.json()["id"] == group_id
    created_events = client.get(f"/api/conversations/{group_id}/messages?token={owner_token}").json()
    assert len(created_events) == 1
    assert group["is_group"] is True
    assert group["creator_id"] == owner_id
    assert group["description"] == "Planning together"
    assert group["member_count"] == 3
    assert next(person for person in group["members"] if person["id"] == owner_id)["is_admin"] is True
    assert next(person for person in group["members"] if person["id"] == member_id)["is_admin"] is False
    assert client.get(f"/api/conversations/{group_id}/messages?token={outsider_token}").status_code == 403
    assert group_id not in [item["id"] for item in client.get(f"/api/conversations?token={outsider_token}").json()]
    assert client.patch(f"/api/conversations/{group_id}/group?token={member_token}", json={"title": "Nope"}).status_code == 403
    assert client.put(f"/api/conversations/{group_id}/members/{owner_id}/role?token={owner_token}",
                      json={"is_admin": False}).status_code == 409

    added = client.post(f"/api/conversations/{group_id}/members?token={owner_token}",
                        json={"member_ids": [late_member_id]})
    assert added.status_code == 200 and added.json()["member_count"] == 4
    assert client.post(f"/api/conversations/{group_id}/members?token={owner_token}",
                       json={"member_ids": [late_member_id]}).status_code == 409
    assert client.post(f"/api/conversations/{group_id}/members?token={member_token}",
                       json={"member_ids": [late_member_id]}).status_code == 403

    changed = client.patch(f"/api/conversations/{group_id}/group?token={owner_token}",
                           json={"title": "Project crew", "description": "Updated description"})
    assert changed.status_code == 200
    assert changed.json()["title"] == "Project crew"
    assert changed.json()["description"] == "Updated description"
    assert client.put(f"/api/conversations/{group_id}/members/{member_id}/role?token={owner_token}",
                      json={"is_admin": True}).status_code == 200
    assert client.delete(f"/api/conversations/{group_id}/members/{owner_id}?token={owner_token}").status_code == 200
    reloaded = client.get(f"/api/conversations/{group_id}?token={member_token}")
    assert reloaded.status_code == 200
    assert next(person for person in reloaded.json()["members"] if person["id"] == member_id)["is_admin"] is True
    assert client.get(f"/api/conversations/{group_id}/messages?token={outsider_token}").status_code == 403

    history = client.get(f"/api/conversations/{group_id}/messages?token={member_token}&limit=2")
    assert history.status_code == 200
    assert len(history.json()) == 2
    assert all(message["is_system"] for message in history.json())
    before = history.json()[0]["id"]
    older = client.get(f"/api/conversations/{group_id}/messages?token={member_token}&limit=2&before_id={before}")
    assert older.status_code == 200
    assert all(message["id"] < before for message in older.json())

def test_group_admin_handover_and_member_access_revocation():
    suffix = uuid.uuid4().hex[:8]
    owner = make_user(f"handover_{suffix}")
    member = make_user(f"handover_member_{suffix}")
    other_member = make_user(f"handover_other_{suffix}")
    owner_token = owner.json()["access_token"]
    member_token = member.json()["access_token"]
    member_id = member.json()["user"]["id"]
    other_member_id = other_member.json()["user"]["id"]
    group = client.post(f"/api/conversations?token={owner_token}", json={
        "member_ids": [member_id, other_member_id], "title": "Handover group", "is_group": True
    }).json()
    cid = group["id"]

    left = client.delete(f"/api/conversations/{cid}/members/{owner.json()['user']['id']}?token={owner_token}")
    assert left.status_code == 200 and left.json() == {"ok": True}
    member_view = client.get(f"/api/conversations/{cid}?token={member_token}")
    assert member_view.status_code == 200
    assert next(person for person in member_view.json()["members"] if person["id"] == member_id)["is_admin"] is True
    assert client.get(f"/api/conversations/{cid}/messages?token={owner_token}").status_code == 403

def test_group_websocket_delivery_and_private_attachment_access():
    suffix = uuid.uuid4().hex[:8]
    owner = make_user(f"ws_owner_{suffix}")
    member = make_user(f"ws_member_{suffix}")
    removed = make_user(f"ws_removed_{suffix}")
    outsider = make_user(f"ws_outsider_{suffix}")
    owner_token = owner.json()["access_token"]
    member_token = member.json()["access_token"]
    outsider_token = outsider.json()["access_token"]
    member_id = member.json()["user"]["id"]
    removed_id = removed.json()["user"]["id"]
    group = client.post(f"/api/conversations?token={owner_token}", json={
        "member_ids": [member_id, removed_id], "title": "Live group", "is_group": True
    }).json()
    cid = group["id"]
    uploaded = client.post(f"/api/uploads?token={owner_token}", files={
        "file": ("notes.txt", b"private group notes", "text/plain")
    })
    assert uploaded.status_code == 200
    attachment = uploaded.json()

    class MemorySocket:
        def __init__(self):
            self.incoming = asyncio.Queue()
            self.outgoing = []
            self.accepted = False

        async def accept(self):
            self.accepted = True

        async def send_json(self, value):
            self.outgoing.append(value)

        async def receive_text(self):
            value = await self.incoming.get()
            if value is None:
                raise WebSocketDisconnect(code=1000)
            return value

        async def close(self, code=1000):
            return None

    async def exercise_sockets():
        member_socket, owner_socket, outsider_socket = MemorySocket(), MemorySocket(), MemorySocket()
        tasks = [
            asyncio.create_task(websocket_endpoint(member_socket, member_token)),
            asyncio.create_task(websocket_endpoint(owner_socket, owner_token)),
            asyncio.create_task(websocket_endpoint(outsider_socket, outsider_token)),
        ]
        for _ in range(100):
            if member_socket.accepted and owner_socket.accepted and outsider_socket.accepted:
                break
            await asyncio.sleep(0.01)
        message_event = {
            "type": "message", "conversation_id": cid, "body": "Hello group",
            "client_nonce": str(uuid.uuid4()),
        }
        await owner_socket.incoming.put(json.dumps(message_event))
        for _ in range(100):
            if any(item.get("type") == "message" for item in member_socket.outgoing):
                break
            await asyncio.sleep(0.01)
        delivered = next(item for item in member_socket.outgoing if item.get("type") == "message")
        assert delivered["message"]["body"] == "Hello group"
        assert delivered["message"]["sender_id"] == owner.json()["user"]["id"]
        assert not any(item.get("type") == "message" for item in outsider_socket.outgoing)
        await owner_socket.incoming.put(json.dumps(message_event))
        for _ in range(100):
            if len([item for item in member_socket.outgoing if item.get("type") == "message"]) >= 2:
                break
            await asyncio.sleep(0.01)
        duplicate_deliveries = [item for item in member_socket.outgoing if item.get("type") == "message"]
        assert duplicate_deliveries[0]["message"]["id"] == duplicate_deliveries[1]["message"]["id"]

        await owner_socket.incoming.put(json.dumps({
            "type": "message", "conversation_id": cid, "body": "",
            "attachment_url": attachment["url"], "attachment_name": attachment["name"],
            "attachment_type": attachment["content_type"], "client_nonce": str(uuid.uuid4()),
        }))
        for _ in range(100):
            if len([item for item in member_socket.outgoing if item.get("type") == "message"]) >= 3:
                break
            await asyncio.sleep(0.01)
        delivered_attachment = [item for item in member_socket.outgoing if item.get("type") == "message"][-1]
        assert delivered_attachment["message"]["attachment_url"] == attachment["url"]

        await outsider_socket.incoming.put(json.dumps({
            "type": "message", "conversation_id": cid, "body": "not allowed",
        }))
        for _ in range(100):
            if any(item.get("type") == "error" for item in outsider_socket.outgoing):
                break
            await asyncio.sleep(0.01)
        assert next(item for item in outsider_socket.outgoing if item.get("type") == "error")["detail"] == "Not a conversation member"

        attachment_message_id = delivered_attachment["message"]["id"]
        with SessionLocal() as db:
            assert get_message_attachment(attachment_message_id, member_token, None, db)
            await remove_group_member(cid, member_id, owner_token, db)
        assert any(item.get("type") == "membership_revoked" for item in member_socket.outgoing)
        await member_socket.incoming.put(json.dumps({
            "type": "message", "conversation_id": cid, "body": "still here",
        }))
        for _ in range(100):
            if any(item.get("type") == "error" for item in member_socket.outgoing):
                break
            await asyncio.sleep(0.01)
        assert next(item for item in member_socket.outgoing if item.get("type") == "error")["detail"] == "Not a conversation member"

        for websocket in [member_socket, owner_socket, outsider_socket]:
            await websocket.incoming.put(None)
        await asyncio.gather(*tasks)
        return attachment_message_id

    attachment_message_id = asyncio.run(exercise_sockets())
    path = f"/api/messages/{attachment_message_id}/attachment"
    assert client.get(path, headers={"Authorization": f"Bearer {owner_token}"}).content == b"private group notes"
    assert client.get(path, headers={"Authorization": f"Bearer {outsider_token}"}).status_code == 404
    assert client.get(path, headers={"Authorization": f"Bearer {member_token}"}).status_code == 404
