# ChatSphere — responsive real-time chat application

## Included in this build
- React + JavaScript + Vite responsive UI, cream/orange theme and motion
- Register/login, Argon2 password hashing and JWT auth
- PostgreSQL support with SQLite local fallback
- User discovery, one-to-one chats and managed group conversations
- Group creation with member selection, admin roles, member add/remove, role changes, leave/handover and editable group details/photos
- Persisted direct/group message history, cursor pagination, idempotent message sends, WebSocket live messaging and typing indicators
- Persistent group system events, per-member unread counts and membership-scoped message delivery
- Online connection presence in one backend process
- Message edit/delete, basic reaction endpoint, read cursor endpoint
- File upload endpoint with MIME allowlist and 8 MB limit (local development storage); downloads require current conversation membership
- Profile display name/about update, archive/mute conversation settings endpoints
- API tests for health, authentication, group permissions and lifecycle, WebSocket delivery/revocation, private attachments and history pagination

## Group-chat schema updates
There is no Alembic migration setup in this project. Startup applies additive, idempotent column/index updates for existing databases and does not drop or recreate tables. The creator foreign key is applied during startup for existing MySQL databases; SQLite cannot add that constraint in place, while newly created tables include it. Back up the database before deploying schema changes.

The WebSocket connection registry is in-memory and therefore supports a single backend worker. Use one worker locally; multi-worker delivery/presence requires shared infrastructure such as Redis, which is not configured here.

## Run on Windows
Backend terminal:
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload
```
Frontend terminal:
```powershell
cd frontend
npm install
Copy-Item .env.example .env
npm run dev
```
API docs: http://127.0.0.1:8000/docs

## PostgreSQL
Set `DATABASE_URL` in `backend/.env`:
`postgresql+psycopg://postgres:YOUR_PASSWORD@localhost:5432/chatsphere`
SQLite is configured as the local fallback. Do not commit `.env` or put database secrets in the frontend.

## Test
```powershell
cd backend
pytest -q
```

## Feature gaps before production
This is a feature-rich MVP foundation, not a security-audited WhatsApp replacement. SMS OTP, email verification/reset delivery, WebRTC voice/video calls, true delivered/read receipts UI, robust reactions display, message forwarding/reply/pinning, block/report moderation, push notifications, private object storage with signed URLs, antivirus scanning, end-to-end encryption, Redis multi-worker presence, Alembic migrations, rate limits, automated browser tests and production monitoring still require implementation/integration. Group/direct uploads use local development storage and membership-checked download routes; production should move them to private object storage. Existing HTTP and WebSocket authentication still uses the starter's token-in-query convention for its API/socket calls; production should use secure cookies or Authorization headers for HTTP and short-lived WebSocket tickets.
