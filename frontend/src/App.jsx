import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Search, Plus, Phone, Video, MoreHorizontal, Smile, Paperclip, Send, Moon, Sun, MessageCircle, Users, Sparkles, ArrowLeft, LogOut, X, UserRound, Camera, Trash2, ShieldCheck, Save } from 'lucide-react'
import Avatar from './components/Avatar.jsx'
import CreateGroupModal from './components/CreateGroupModal.jsx'
import GroupDetailsModal from './components/GroupDetailsModal.jsx'
import GroupConversationHeader from './components/GroupConversationHeader.jsx'
import ConversationItem from './components/ConversationItem.jsx'
import MessageList from './components/MessageList.jsx'

const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
const friendlyError = error => error instanceof Error ? error.message : 'Something went wrong'

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('chatsphere_token') || '')
  const [me, setMe] = useState(null)
  const [authMode, setAuthMode] = useState('login')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [users, setUsers] = useState([])
  const [conversations, setConversations] = useState([])
  const [active, setActive] = useState(null)
  const [messages, setMessages] = useState([])
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [draft, setDraft] = useState('')
  const [pendingAttachment, setPendingAttachment] = useState(null)
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState('')
  const [showPeople, setShowPeople] = useState(false)
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [showGroupDetails, setShowGroupDetails] = useState(false)
  const [dark, setDark] = useState(false)
  const [mobileChat, setMobileChat] = useState(false)
  const [socketState, setSocketState] = useState('offline')
  const [typingUsers, setTypingUsers] = useState([])
  const [toast, setToast] = useState('')
  const [showEmoji, setShowEmoji] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [selectedProfile, setSelectedProfile] = useState(null)
  const [profileDraft, setProfileDraft] = useState({ display_name: '', username: '', about: '', profile_photo_visibility: 'everyone', about_visibility: 'everyone' })
  const [avatarFile, setAvatarFile] = useState(null)
  const [avatarPreview, setAvatarPreview] = useState('')
  const [avatarZoom, setAvatarZoom] = useState(1)
  const [profileSaving, setProfileSaving] = useState(false)
  const avatarInput = useRef(null)
  const attachmentInput = useRef(null)
  const socket = useRef(null)
  const bottomRef = useRef(null)
  const bottomMessageId = useRef(null)
  const typingTimer = useRef(null)
  const lastTypingSent = useRef(0)

  useEffect(() => () => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview)
  }, [avatarPreview])

  const request = useCallback(async (path, options = {}) => {
    const isFormData = options.body instanceof FormData
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { ...(!isFormData ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`)
    return data
  }, [])

  useEffect(() => {
    if (!token) return
    request(`/api/me?token=${encodeURIComponent(token)}`).then(setMe).catch(() => {
      localStorage.removeItem('chatsphere_token'); setToken(''); setMe(null)
    })
  }, [token, request])

  const refreshInbox = useCallback(async () => {
    if (!token || !me) return
    try {
      const [people, chats] = await Promise.all([
        request(`/api/users?token=${encodeURIComponent(token)}`),
        request(`/api/conversations?token=${encodeURIComponent(token)}`)
      ])
      setUsers(people)
      setConversations(chats)
      setActive(current => current ? (chats.find(c => c.id === current.id) || null) : (chats[0] || null))
    } catch (e) { setToast(friendlyError(e)) }
  }, [token, me, request])

  useEffect(() => { refreshInbox() }, [refreshInbox])

  useEffect(() => {
    if (!token) return
    let closedByCleanup = false
    let reconnectTimer
    const connect = () => {
      if (closedByCleanup) return
      setSocketState('connecting')
      const ws = new WebSocket(API.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(token)}`)
      socket.current = ws
      ws.onopen = () => setSocketState('connected')
      ws.onmessage = event => {
        const data = JSON.parse(event.data)
        if (data.type === 'message') {
          const msg = data.message
          setMessages(current => msg.conversation_id === activeRef.current?.id && !current.some(m => m.id === msg.id) ? [...current, msg] : current)
          setConversations(current => current.map(c => c.id === msg.conversation_id ? { ...c,
            unread_count: msg.conversation_id === activeRef.current?.id ? 0 : (c.unread_count || 0) + (msg.sender_id === me?.id ? 0 : 1),
            last_message: { body: msg.body, created_at: msg.created_at, sender_id: msg.sender_id }
          } : c).sort((a, b) => {
            const at = a.last_message?.created_at || a.created_at
            const bt = b.last_message?.created_at || b.created_at
            return new Date(bt) - new Date(at)
          }))
          if (msg.conversation_id === activeRef.current?.id) {
            request(`/api/conversations/${msg.conversation_id}/read?token=${encodeURIComponent(token)}`, { method: 'POST' })
              .catch(e => setToast(friendlyError(e)))
          }
        } else if (data.type === 'group_updated') {
          refreshInbox()
          if (data.conversation_id === activeRef.current?.id) {
            request(`/api/conversations/${data.conversation_id}/messages?token=${encodeURIComponent(token)}`)
              .then(setMessages).catch(e => setToast(friendlyError(e)))
          }
        } else if (data.type === 'membership_revoked') {
          if (data.conversation_id === activeRef.current?.id) {
            setActive(null)
            setMessages([])
            setMobileChat(false)
            setToast('You are no longer a member of this group.')
          }
          refreshInbox()
        } else if (data.type === 'typing') {
          if (data.conversation_id === activeRef.current?.id && data.user_id !== me?.id) {
            setTypingUsers(current => data.is_typing ? [...new Set([...current, data.user_id])] : current.filter(id => id !== data.user_id))
            if (data.is_typing) {
              clearTimeout(typingTimer.current)
              typingTimer.current = setTimeout(() => setTypingUsers([]), 2200)
            }
          }
        } else if (data.type === 'error') setToast(data.detail)
      }
      ws.onclose = () => {
        setSocketState('offline')
        if (!closedByCleanup) reconnectTimer = setTimeout(connect, 1600)
      }
      ws.onerror = () => setSocketState('offline')
    }
    connect()
    return () => { closedByCleanup = true; clearTimeout(reconnectTimer); socket.current?.close(); socket.current = null }
  }, [token, me?.id, refreshInbox, request])

  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])

  useEffect(() => {
    if (!token || !active) { setMessages([]); setHasOlderMessages(false); return }
    request(`/api/conversations/${active.id}/messages?token=${encodeURIComponent(token)}&limit=100`)
      .then(result => {
        setMessages(result)
        setHasOlderMessages(result.length === 100)
        return request(`/api/conversations/${active.id}/read?token=${encodeURIComponent(token)}`, { method: 'POST' })
      }).then(() => setConversations(current => current.map(item => item.id === active.id ? { ...item, unread_count: 0 } : item)))
      .catch(e => setToast(friendlyError(e)))
  }, [token, active?.id, request])

  useEffect(() => {
    const latestId = messages[messages.length - 1]?.id ?? null
    if (latestId !== bottomMessageId.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
      bottomMessageId.current = latestId
    }
  }, [messages])

  async function loadOlderMessages() {
    if (!active || !messages.length || loadingOlder || !hasOlderMessages) return
    setLoadingOlder(true)
    try {
      const older = await request(`/api/conversations/${active.id}/messages?token=${encodeURIComponent(token)}&limit=100&before_id=${messages[0].id}`)
      setMessages(current => {
        const known = new Set(current.map(message => message.id))
        return [...older.filter(message => !known.has(message.id)), ...current]
      })
      setHasOlderMessages(older.length === 100)
    } catch (e) { setToast(friendlyError(e)) }
    finally { setLoadingOlder(false) }
  }

  const filteredConversations = useMemo(() => conversations.filter(c => {
    const title = c.title || c.members?.filter(m => m.id !== me?.id).map(m => m.display_name || m.username).join(' ')
    return `${title} ${c.last_message?.body || ''}`.toLowerCase().includes(search.toLowerCase())
  }), [conversations, search, me?.id])
  const peopleFiltered = useMemo(() => users.filter(u => `${u.display_name} ${u.username}`.toLowerCase().includes(search.toLowerCase())), [users, search])
  const otherMembers = active?.members?.filter(m => m.id !== me?.id) || []
  const activeTitle = active ? (active.title || otherMembers.map(m => m.display_name || m.username).join(', ')) : 'Your conversations'
  const activeOnline = socketState === 'connected'

  function onGroupCreated(conversation) {
    setConversations(current => [conversation, ...current.filter(item => item.id !== conversation.id)])
    setActive(conversation)
    setShowPeople(false)
    setMobileChat(true)
    setToast('Your group is ready.')
  }

  function updateConversation(conversation) {
    setConversations(current => {
      const next = current.filter(item => item.id !== conversation.id)
      return conversation.is_archived ? next : [conversation, ...next]
    })
    setActive(current => current?.id === conversation.id ? conversation : current)
  }

  async function authenticate(event) {
    event.preventDefault(); setAuthError('')
    try {
      const body = authMode === 'register'
        ? { username, display_name: displayName.trim() || username, password }
        : { username, password }
      const data = await request(`/api/auth/${authMode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(body) })
      localStorage.setItem('chatsphere_token', data.access_token)
      setToken(data.access_token); setMe(data.user)
    } catch (e) { setAuthError(friendlyError(e)) }
  }

  function openMyProfile() {
    setProfileDraft({
      display_name: me.display_name || '',
      username: me.username || '',
      about: me.about || '',
      profile_photo_visibility: me.profile_photo_visibility || 'everyone',
      about_visibility: me.about_visibility || 'everyone'
    })
    setAvatarFile(null)
    setAvatarPreview('')
    setAvatarZoom(1)
    setShowProfile(true)
  }

  function closeMyProfile() {
    if (profileSaving) return
    setShowProfile(false)
    setAvatarFile(null)
    setAvatarPreview('')
  }

  async function openUserProfile(userId) {
    try {
      const profile = await request(`/api/users/${userId}/profile?token=${encodeURIComponent(token)}`)
      setSelectedProfile(profile)
    } catch (e) { setToast(friendlyError(e)) }
  }

  function chooseAvatar(file) {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      setToast('Choose a JPEG, PNG, WebP, or GIF image.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setToast('Profile photos must be 5 MB or smaller.')
      return
    }
    setAvatarFile(file)
    setAvatarPreview(URL.createObjectURL(file))
    setAvatarZoom(1)
  }

  async function saveProfile(event) {
    event.preventDefault()
    if (!profileDraft.display_name.trim() || !profileDraft.username.trim()) {
      setToast('Display name and username are required.')
      return
    }
    setProfileSaving(true)
    try {
      const updated = await request(`/api/me?token=${encodeURIComponent(token)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          display_name: profileDraft.display_name,
          username: profileDraft.username,
          about: profileDraft.about,
          profile_photo_visibility: profileDraft.profile_photo_visibility,
          about_visibility: profileDraft.about_visibility
        })
      })
      setMe(updated)
      if (avatarFile) {
        const bitmap = await createImageBitmap(avatarFile)
        const side = Math.min(bitmap.width, bitmap.height) / avatarZoom
        const left = (bitmap.width - side) / 2
        const top = (bitmap.height - side) / 2
        const canvas = document.createElement('canvas')
        canvas.width = 512
        canvas.height = 512
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Could not prepare this image for upload.')
        context.drawImage(bitmap, left, top, side, side, 0, 0, 512, 512)
        bitmap.close()
        const cropped = await new Promise((resolve, reject) => canvas.toBlob(blob => {
          if (blob) resolve(blob)
          else reject(new Error('Could not prepare this image for upload.'))
        }, 'image/jpeg', 0.9))
        const form = new FormData()
        form.append('file', new File([cropped], 'profile-photo.jpg', { type: 'image/jpeg' }))
        const withAvatar = await request(`/api/me/avatar?token=${encodeURIComponent(token)}`, { method: 'POST', body: form })
        setMe(withAvatar)
      }
      setAvatarFile(null)
      setAvatarPreview('')
      setShowProfile(false)
      setToast('Your profile is up to date.')
    } catch (e) { setToast(friendlyError(e)) }
    finally { setProfileSaving(false) }
  }

  async function removeAvatar() {
    setAvatarFile(null)
    setAvatarPreview('')
    try {
      const updated = await request(`/api/me/avatar?token=${encodeURIComponent(token)}`, { method: 'DELETE' })
      setMe(updated)
    } catch (e) { setToast(friendlyError(e)) }
  }

  async function startChat(user) {
    try {
      const c = await request(`/api/conversations?token=${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify({ member_ids: [user.id] }) })
      const enriched = { ...c, members: c.members || [me, user].filter(Boolean), last_message: c.last_message || null }
      setConversations(current => [enriched, ...current.filter(item => item.id !== enriched.id)])
      setActive(enriched); setMobileChat(true); setShowPeople(false); setSearch('')
    } catch (e) { setToast(friendlyError(e)) }
  }

  function chooseAttachment(file) {
    if (!file) return
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']
    if (!allowedTypes.includes(file.type)) {
      setToast('Choose an image, PDF, or plain text file.')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setToast('Attachments must be 8 MB or smaller.')
      return
    }
    setPendingAttachment(file)
  }

  async function downloadAttachment(message) {
    if (!message.attachment_url) return
    try {
      const response = await fetch(`${API}/api/messages/${message.id}/attachment`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.detail || `Download failed (${response.status})`)
      }
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = message.attachment_name || 'attachment'
      link.click()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch (e) { setToast(friendlyError(e)) }
  }

  async function sendMessage(event) {
    event?.preventDefault()
    const body = draft.trim()
    if ((!body && !pendingAttachment) || !active || sending) return
    if (socket.current?.readyState !== WebSocket.OPEN) { setToast('Reconnecting… please try again in a moment.'); return }
    setSending(true)
    try {
      let attachment = null
      if (pendingAttachment) {
        const form = new FormData()
        form.append('file', pendingAttachment)
        attachment = await request(`/api/uploads?token=${encodeURIComponent(token)}`, { method: 'POST', body: form })
      }
      if (socket.current?.readyState !== WebSocket.OPEN) throw new Error('Reconnecting… please try sending again.')
      socket.current.send(JSON.stringify({
        type: 'message',
        conversation_id: active.id,
        body,
        attachment_url: attachment?.url,
        attachment_name: attachment?.name,
        attachment_type: attachment?.content_type,
        client_nonce: globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
          const value = Math.random() * 16 | 0
          return (character === 'x' ? value : value & 0x3 | 0x8).toString(16)
        })
      }))
      setDraft('')
      setPendingAttachment(null)
      setShowEmoji(false)
      socket.current.send(JSON.stringify({ type: 'typing', conversation_id: active.id, is_typing: false }))
    } catch (e) { setToast(friendlyError(e)) }
    finally { setSending(false) }
  }

  function onDraftChange(value) {
    setDraft(value)
    if (!active || socket.current?.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (now - lastTypingSent.current > 500) {
      socket.current.send(JSON.stringify({ type: 'typing', conversation_id: active.id, is_typing: Boolean(value.trim()) }))
      lastTypingSent.current = now
    }
  }

  function logout() {
    localStorage.removeItem('chatsphere_token')
    setToken(''); setMe(null); setMessages([]); setConversations([]); setActive(null)
    socket.current?.close()
  }

  if (!token || !me) return <main className={`auth-page ${dark ? 'theme-dark' : 'theme-light'}`}>
    <div className="ambient ambient-one"/><div className="ambient ambient-two"/>
    <motion.section className="auth-card" initial={{ opacity: 0, y: 18, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: .45 }}>
      <div className="auth-brand"><span className="brand-symbol"><MessageCircle size={24}/></span><span>chat<span>sphere</span></span></div>
      <div className="eyebrow"><Sparkles size={14}/> YOUR LITTLE CORNER OF THE INTERNET</div>
      <h1>Good conversations<br/><em>feel like home.</em></h1>
      <p className="muted">A warmer, calmer space for the people who matter.</p>
      <form onSubmit={authenticate} className="auth-form">
        {authMode === 'register' && <label>Full name<input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your name" maxLength={80} required/></label>}
        <label>Username<input value={username} onChange={e => setUsername(e.target.value)} placeholder="your.username" minLength={3} maxLength={32} autoComplete="username" required/></label>
        <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" minLength={8} maxLength={128} autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} required/></label>
        {authError && <p className="error-text" role="alert">{authError}</p>}
        <button className="primary-button wide" type="submit">{authMode === 'register' ? 'Create your account' : 'Welcome back'} <span>↗</span></button>
      </form>
      <p className="auth-switch">{authMode === 'register' ? 'Already have a space?' : 'New around here?'} <button onClick={() => { setAuthMode(authMode === 'register' ? 'login' : 'register'); setAuthError('') }}>{authMode === 'register' ? 'Sign in' : 'Create an account'}</button></p>
      <button className="theme-toggle auth-theme" onClick={() => setDark(!dark)}>{dark ? <Sun size={16}/> : <Moon size={16}/>} {dark ? 'Light mode' : 'Dark mode'}</button>
      <div className="auth-decoration decor-a"/><div className="auth-decoration decor-b"/>
    </motion.section>
  </main>

  return <main className={`app-shell ${dark ? 'theme-dark' : 'theme-light'}`}>
    <div className="ambient ambient-one"/><div className="ambient ambient-two"/>
    <motion.div className="app-window" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .4 }}>
      <aside className={`sidebar ${mobileChat ? 'mobile-hidden' : ''}`}>
        <header className="sidebar-header">
          <div className="brand"><span className="brand-symbol small"><MessageCircle size={18}/></span><span>chat<span>sphere</span></span></div>
          <button className="icon-button" title="Start a conversation" onClick={() => { setShowPeople(v => !v); setSearch('') }}>{showPeople ? <X size={18}/> : <Plus size={18}/>}</button>
        </header>
        <div className="welcome-line"><div><span className="tiny muted">YOUR SPACE</span><h2>Hi, {me.display_name.split(' ')[0]} <span className="wave">✦</span></h2></div><span className={`connection-dot ${activeOnline ? 'is-online' : ''}`} title={`Socket ${socketState}`}/></div>
        <div className="search-box"><Search size={16}/><input placeholder={showPeople ? 'Find people...' : 'Search conversations...'} value={search} onChange={e => setSearch(e.target.value)}/>{search && <button className="tiny-clear" onClick={() => setSearch('')}><X size={14}/></button>}</div>
        {!showPeople && <div className="new-group-row"><button className="soft-button" onClick={() => setShowCreateGroup(true)}><Users size={15}/> New group</button></div>}
        <div className="sidebar-tabs"><span>{showPeople ? 'PEOPLE YOU MAY KNOW' : 'YOUR CONVERSATIONS'}</span><button onClick={() => setShowPeople(v => !v)}>{showPeople ? 'Chats' : 'Find people'}</button></div>
        <div className="conversation-list">
          {showPeople ? peopleFiltered.map((person, index) => <motion.button key={person.id} className="conversation-item" onClick={() => startChat(person)} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * .025 }}>
            <span className="avatar-action" role="button" tabIndex={0} aria-label={`View ${person.display_name || person.username}'s profile`} onClick={event => { event.stopPropagation(); openUserProfile(person.id) }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); openUserProfile(person.id) } }}><Avatar name={person.display_name || person.username} index={index} seed={person.username} avatarUrl={person.avatar_url} token={token}/></span><span className="conversation-copy"><strong>{person.display_name || person.username}</strong><small>@{person.username}</small></span><Plus size={16} className="person-add"/>
          </motion.button>) : filteredConversations.map((conversation, index) => <ConversationItem
            key={conversation.id}
            conversation={conversation}
            index={index}
            currentUserId={me.id}
            active={active?.id === conversation.id}
            token={token}
            onSelect={item => { setActive(item); setMobileChat(true) }}
            onOpenProfile={openUserProfile}
            onOpenDetails={item => { setActive(item); setShowGroupDetails(true) }}
          />)}
          {!showPeople && filteredConversations.length === 0 && <div className="empty-list"><span className="empty-orb"><MessageCircle size={20}/></span><strong>Your story starts here</strong><p>Find someone and send the first hello.</p><button className="soft-button" onClick={() => { setShowPeople(true); setSearch('') }}>Find people <Plus size={14}/></button></div>}
          {showPeople && peopleFiltered.length === 0 && <p className="muted empty-hint">No people found. Ask a friend to create an account.</p>}
        </div>
        <footer className="profile-footer">
          <button className="account-button" onClick={openMyProfile} aria-label="Open my profile">
            <Avatar name={me.display_name} index={2} seed={me.username} avatarUrl={me.avatar_url} token={token}/>
            <span className="profile-copy"><strong>{me.display_name}</strong><small>@{me.username}</small></span>
          </button>
          <button className="icon-button" title="Toggle theme" onClick={() => setDark(!dark)}>{dark ? <Sun size={17}/> : <Moon size={17}/>}</button>
          <button className="icon-button" title="Sign out" onClick={logout}><LogOut size={17}/></button>
        </footer>
      </aside>

      <section className={`chat-panel ${mobileChat ? 'mobile-visible' : ''}`}>
        {active ? <>
          <header className="chat-header">
            <button className="icon-button mobile-back" aria-label="Back to conversations" onClick={() => setMobileChat(false)}><ArrowLeft size={19}/></button>
            {active.is_group
              ? <GroupConversationHeader conversation={active} title={activeTitle} token={token} onOpenDetails={() => setShowGroupDetails(true)}/>
              : <>
                <button className="chat-header-avatar" aria-label={`View ${activeTitle} profile`} onClick={() => otherMembers[0] && openUserProfile(otherMembers[0].id)}><Avatar name={activeTitle} seed={otherMembers[0]?.username || activeTitle} avatarUrl={otherMembers[0]?.avatar_url} token={token}/></button>
                <button className="chat-heading chat-heading-button" onClick={() => otherMembers[0] && openUserProfile(otherMembers[0].id)}><h2>{activeTitle}</h2><p><span className={`presence-dot ${activeOnline ? 'is-online' : ''}`}/>{typingUsers.length ? 'typing…' : activeOnline ? 'Connected · messages are live' : 'Reconnecting to chat…'}</p></button>
              </>}
            <div className="chat-actions"><button className="icon-button" title="Voice call (coming soon)" onClick={() => setToast('Voice calls are not enabled in this starter yet.')}><Phone size={18}/></button><button className="icon-button" title="Video call (coming soon)" onClick={() => setToast('Video calls are not enabled in this starter yet.')}><Video size={18}/></button><button className="icon-button" title={active.is_group ? 'Group details' : 'More options'} onClick={() => active.is_group ? setShowGroupDetails(true) : setToast('Conversation options are coming in a later milestone.')}><MoreHorizontal size={20}/></button></div>
          </header>
          <div className="chat-date"><span>YOUR LITTLE CORNER OF THE INTERNET</span></div>
          <MessageList conversation={active} title={activeTitle} messages={messages} currentUserId={me.id} token={token}
            bottomRef={bottomRef} hasOlder={hasOlderMessages} loadingOlder={loadingOlder} typingUsers={typingUsers} onLoadOlder={loadOlderMessages}
            onOpenProfile={openUserProfile} onDownloadAttachment={downloadAttachment}/>
          {pendingAttachment && <div className="pending-attachment"><Paperclip size={13}/><span>{pendingAttachment.name}</span><button type="button" aria-label="Remove attachment" onClick={() => setPendingAttachment(null)}><X size={13}/></button></div>}
          <form className="composer" onSubmit={sendMessage}>
            <button type="button" className="composer-icon" title="Emoji" onClick={() => setShowEmoji(v => !v)}><Smile size={20}/></button>
            <button type="button" className="composer-icon attach-button" title="Attach a file" onClick={() => attachmentInput.current?.click()}><Paperclip size={19}/></button>
            <input ref={attachmentInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain" onChange={event => { chooseAttachment(event.target.files?.[0]); event.target.value = '' }}/>
            <input value={draft} onChange={e => onDraftChange(e.target.value)} placeholder="Write a little something..." aria-label="Write a message" maxLength={5000}/>
            <span className="composer-spark">✦</span>
            <button type="submit" className="send-button" aria-label="Send message" disabled={(!draft.trim() && !pendingAttachment) || sending}>{sending ? '…' : <Send size={17}/>}</button>
            {showEmoji && <div className="emoji-popover">{['😊','❤️','😂','✨','🙌','🥹','👋','🔥','💛','🎉','🤍','🌻'].map(emoji => <button type="button" key={emoji} onClick={() => { setDraft(v => v + emoji); setShowEmoji(false) }}>{emoji}</button>)}</div>}
          </form>
          <div className="chat-footnote"><span className={`connection-dot ${activeOnline ? 'is-online' : ''}`}/>{activeOnline ? 'Connected securely · your messages are saved' : 'Trying to reconnect…'} <span>Made for meaningful moments</span></div>
        </> : <div className="welcome-panel"><div className="welcome-orb"><MessageCircle size={36}/><span>✦</span></div><p className="eyebrow">A LITTLE SPACE TO CONNECT</p><h1>Good conversations<br/><em>start somewhere.</em></h1><p>Choose a conversation or find a friend to begin.</p><button className="primary-button" onClick={() => setShowPeople(true)}>Find someone <Plus size={16}/></button><div className="floating-chip chip-one">✦ little moments</div><div className="floating-chip chip-two">♡ real connection</div></div>}
      </section>
    </motion.div>
    <AnimatePresence>
      {showProfile && <motion.div className="profile-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeMyProfile}>
        <motion.section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title" initial={{ opacity: 0, y: 18, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: .98 }} onClick={event => event.stopPropagation()}>
          <header className="profile-dialog-header"><div><span className="eyebrow"><UserRound size={14}/> YOUR IDENTITY</span><h2 id="profile-title">My profile</h2></div><button className="icon-button" type="button" aria-label="Close profile" onClick={closeMyProfile}><X size={18}/></button></header>
          <form className="profile-form" onSubmit={saveProfile}>
            <div className="profile-hero">
                <div className="profile-photo-wrap"><Avatar name={profileDraft.display_name || me.display_name} index={2} seed={me.username} avatarUrl={avatarPreview ? null : me.avatar_url} token={token} preview={avatarPreview} zoom={avatarZoom}/><button className="photo-camera" type="button" aria-label="Choose profile photo" disabled={profileSaving} onClick={() => avatarInput.current?.click()}><Camera size={16}/></button></div>
                <div><strong>{profileDraft.display_name || me.display_name}</strong><small>@{profileDraft.username || me.username}</small><button className="photo-link" type="button" disabled={profileSaving} onClick={() => avatarInput.current?.click()}>{avatarFile ? 'Choose a different photo' : 'Change photo'}</button>{me.avatar_url && <button className="photo-remove" type="button" disabled={profileSaving} onClick={removeAvatar}><Trash2 size={13}/> Remove photo</button>}</div>
                <input ref={avatarInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={event => { chooseAvatar(event.target.files?.[0]); event.target.value = '' }}/>
            </div>
            {avatarFile && <div className="zoom-control"><label htmlFor="avatar-zoom">Crop & zoom</label><input id="avatar-zoom" type="range" min="1" max="2" step="0.05" value={avatarZoom} onChange={event => setAvatarZoom(Number(event.target.value))}/><span>{avatarZoom.toFixed(1)}×</span></div>}
            <label className="profile-field">Display name<input value={profileDraft.display_name} maxLength={80} onChange={event => setProfileDraft(current => ({ ...current, display_name: event.target.value }))}/></label>
            <label className="profile-field">Username<div className="username-input"><span>@</span><input value={profileDraft.username} minLength={3} maxLength={32} pattern="[A-Za-z0-9_.-]+" onChange={event => setProfileDraft(current => ({ ...current, username: event.target.value }))}/></div></label>
            <label className="profile-field">About<textarea value={profileDraft.about} maxLength={160} rows={2} placeholder="A little about you..." onChange={event => setProfileDraft(current => ({ ...current, about: event.target.value }))}/><small>{profileDraft.about.length}/160</small></label>
            <section className="privacy-card"><div className="privacy-heading"><ShieldCheck size={17}/><div><strong>Privacy & visibility</strong><small>Choose who can see your details</small></div></div>
              <label className="privacy-row">Profile photo<select value={profileDraft.profile_photo_visibility} onChange={event => setProfileDraft(current => ({ ...current, profile_photo_visibility: event.target.value }))}><option value="everyone">Everyone</option><option value="nobody">Nobody</option></select></label>
              <label className="privacy-row">About<select value={profileDraft.about_visibility} onChange={event => setProfileDraft(current => ({ ...current, about_visibility: event.target.value }))}><option value="everyone">Everyone</option><option value="nobody">Nobody</option></select></label>
              <p>“My contacts” will be available when contact management is supported.</p>
            </section>
            <button className="primary-button profile-save" type="submit" disabled={profileSaving}>{profileSaving ? 'Saving…' : 'Save changes'} <Save size={15}/></button>
          </form>
        </motion.section>
      </motion.div>}
      {selectedProfile && <motion.div className="profile-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelectedProfile(null)}>
        <motion.section className="profile-dialog public-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="public-profile-title" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} onClick={event => event.stopPropagation()}>
          <header className="profile-dialog-header"><div><span className="eyebrow"><UserRound size={14}/> CHATSPHERE MEMBER</span></div><button className="icon-button" type="button" aria-label="Close profile" onClick={() => setSelectedProfile(null)}><X size={18}/></button></header>
          <div className="public-profile-card"><Avatar name={selectedProfile.display_name || selectedProfile.username} index={2} seed={selectedProfile.username} avatarUrl={selectedProfile.avatar_url} token={token}/><h2 id="public-profile-title">{selectedProfile.display_name || selectedProfile.username}</h2><span>@{selectedProfile.username}</span><p>{selectedProfile.about_visible ? (selectedProfile.about || 'No About message yet.') : 'This person keeps their About private.'}</p></div>
        </motion.section>
      </motion.div>}
    </AnimatePresence>
    {showCreateGroup && <CreateGroupModal users={users} token={token} request={request} onClose={() => setShowCreateGroup(false)} onCreated={onGroupCreated} onError={setToast}/>}
    {showGroupDetails && active?.is_group && <GroupDetailsModal conversation={active} users={users} currentUserId={me.id} token={token} request={request} onClose={() => setShowGroupDetails(false)} onUpdated={updateConversation} onLeft={() => { setShowGroupDetails(false); setActive(null); setMessages([]); setMobileChat(false); refreshInbox() }}/>}
    <AnimatePresence>{toast && <motion.div className="toast" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}><span>{toast}</span><button onClick={() => setToast('')}><X size={15}/></button></motion.div>}</AnimatePresence>
  </main>
}
