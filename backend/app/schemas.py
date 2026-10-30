from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field

class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_.-]+$")
    display_name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=128)

class LoginIn(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=1, max_length=128)

class UserOut(BaseModel):
    id: int
    username: str
    display_name: str
    avatar_url: str | None = None
    about: str | None = "Available to chat"
    about_visible: bool = True
    model_config = {"from_attributes": True}

class MyProfileOut(UserOut):
    profile_photo_visibility: Literal["everyone", "nobody"] = "everyone"
    about_visibility: Literal["everyone", "nobody"] = "everyone"

class ProfileIn(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    username: str | None = Field(default=None, min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_.-]+$")
    about: str | None = Field(default=None, max_length=160)
    profile_photo_visibility: Literal["everyone", "nobody"] | None = None
    about_visibility: Literal["everyone", "nobody"] | None = None

class AuthOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut

class ConversationIn(BaseModel):
    member_ids: list[int] = Field(min_length=1, max_length=30)
    title: str | None = Field(default=None, max_length=120)
    description: str = Field(default="", max_length=500)
    is_group: bool = False

class GroupUpdateIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)

class GroupMembersIn(BaseModel):
    member_ids: list[int] = Field(min_length=1, max_length=30)

class GroupRoleIn(BaseModel):
    is_admin: bool

class MessageOut(BaseModel):
    id: int
    conversation_id: int
    sender_id: int
    body: str
    attachment_url: str | None = None
    attachment_name: str | None = None
    attachment_type: str | None = None
    edited_at: datetime | None = None
    deleted_at: datetime | None = None
    is_system: bool = False
    client_nonce: str | None = None
    created_at: datetime
    model_config = {"from_attributes": True}

class MessageEditIn(BaseModel):
    body: str = Field(min_length=1, max_length=5000)

class ReactionIn(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)
