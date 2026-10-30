import { useEffect, useMemo, useState } from 'react'
import { Archive, Camera, Check, LogOut, ShieldCheck, UserPlus, X } from 'lucide-react'
import Avatar from './Avatar.jsx'

export default function GroupDetailsModal({ conversation, users, currentUserId, token, request, onClose, onUpdated, onLeft }) {
  const [group, setGroup] = useState(conversation)
  const [name, setName] = useState(conversation.title || '')
  const [description, setDescription] = useState(conversation.description || '')
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [selectedToAdd, setSelectedToAdd] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const meIsAdmin = Boolean(group.members?.find(member => member.id === currentUserId)?.is_admin)
  const candidates = useMemo(() => (search.trim() ? searchResults || [] : users).filter(person =>
    !group.members?.some(member => member.id === person.id) &&
    (!search.trim() || `${person.display_name} ${person.username}`.toLowerCase().includes(search.toLowerCase()))
  ), [users, group.members, search, searchResults])

  useEffect(() => {
    if (!search.trim()) {
      setSearchResults(null)
      setSearching(false)
      return undefined
    }
    let cancelled = false
    setSearchResults(null)
    setSearching(true)
    const timer = setTimeout(() => {
      request(`/api/users?search=${encodeURIComponent(search.trim())}&token=${encodeURIComponent(token)}`)
        .then(results => { if (!cancelled) setSearchResults(results) })
        .catch(requestError => { if (!cancelled) setError(requestError.message) })
        .finally(() => { if (!cancelled) setSearching(false) })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search, token, request])

  async function reload() {
    const fresh = await request(`/api/conversations/${conversation.id}?token=${encodeURIComponent(token)}`)
    setGroup(fresh)
    setName(fresh.title || '')
    setDescription(fresh.description || '')
    onUpdated(fresh)
  }

  useEffect(() => {
    reload().catch(requestError => setError(requestError.message))
  }, [conversation.id])

  async function perform(action) {
    setBusy(true)
    setError('')
    try {
      await action()
      await reload()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function saveDetails(event) {
    event.preventDefault()
    const photo = event.currentTarget.elements.groupPhoto.files?.[0]
    if (photo && !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(photo.type)) {
      setError('Choose a JPEG, PNG, WebP, or GIF group photo.')
      return
    }
    if (photo && photo.size > 5 * 1024 * 1024) {
      setError('Group photos must be 5 MB or smaller.')
      return
    }
    await perform(async () => {
      let updated = await request(`/api/conversations/${group.id}/group?token=${encodeURIComponent(token)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: name.trim(), description: description.trim() })
      })
      if (photo) {
        const form = new FormData()
        form.append('file', photo)
        updated = await request(`/api/conversations/${group.id}/avatar?token=${encodeURIComponent(token)}`, { method: 'POST', body: form })
      }
      setGroup(updated)
      onUpdated(updated)
    })
  }

  function addMembers() {
    if (!selectedToAdd.length) return
    perform(async () => {
      await request(`/api/conversations/${group.id}/members?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        body: JSON.stringify({ member_ids: selectedToAdd })
      })
      setSelectedToAdd([])
    })
  }

  function removeMember(member) {
    if (!window.confirm(`Remove ${member.display_name || member.username} from this group?`)) return
    perform(() => request(`/api/conversations/${group.id}/members/${member.id}?token=${encodeURIComponent(token)}`, { method: 'DELETE' }))
  }

  function leave() {
    if (!window.confirm(`Leave ${group.title}?`)) return
    setBusy(true)
    request(`/api/conversations/${group.id}/members/${currentUserId}?token=${encodeURIComponent(token)}`, { method: 'DELETE' })
      .then(onLeft)
      .catch(requestError => setError(requestError.message))
      .finally(() => setBusy(false))
  }

  async function updateSettings(field, value) {
    await perform(() => request(`/api/conversations/${group.id}/settings?${field}=${value}&token=${encodeURIComponent(token)}`, { method: 'PATCH' }))
  }

  return <div className="group-overlay" onClick={onClose}>
    <section className="group-dialog group-details-dialog" role="dialog" aria-modal="true" aria-labelledby="group-details-title" onClick={event => event.stopPropagation()}>
      <header className="group-dialog-header">
        <div><span className="eyebrow">YOUR GROUP</span><h2 id="group-details-title">Group details</h2></div>
        <button type="button" className="icon-button" aria-label="Close group details" onClick={onClose}><X size={18}/></button>
      </header>
      <div className="group-details-scroll">
        <div className="group-details-hero">
          <Avatar name={group.title} seed={group.title} group avatarUrl={group.avatar_url} token={token}/>
          <div><h3>{group.title}</h3><span>{group.member_count || group.members?.length || 0} members</span></div>
        </div>
        {meIsAdmin && <form className="group-form group-edit-form" onSubmit={saveDetails}>
          <label className="profile-field">Group name<input value={name} onChange={event => setName(event.target.value)} maxLength={120} required disabled={busy}/></label>
          <label className="profile-field">Description<textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={500} disabled={busy}/></label>
          <label className="group-photo-change"><Camera size={15}/> Change group photo<input name="groupPhoto" type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={busy}/></label>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save group details'} <Check size={15}/></button>
        </form>}
        <section className="group-members-section">
          <header className="group-section-heading"><strong>Members</strong><span>{group.member_count || group.members?.length || 0}</span></header>
          <div className="group-member-list">
            {group.members?.map(member => <div className="group-member" key={member.id}>
              <Avatar name={member.display_name || member.username} seed={member.username} avatarUrl={member.avatar_url} token={token}/>
              <span className="conversation-copy"><strong>{member.display_name || member.username}</strong><small>@{member.username}</small></span>
              {member.is_admin && <span className="admin-badge"><ShieldCheck size={12}/> Admin</span>}
              {meIsAdmin && member.id !== currentUserId && <div className="member-actions">
                <button type="button" className="soft-button compact" disabled={busy} onClick={() => perform(() => request(`/api/conversations/${group.id}/members/${member.id}/role?token=${encodeURIComponent(token)}`, {
                  method: 'PUT', body: JSON.stringify({ is_admin: !member.is_admin })
                }))}>{member.is_admin ? 'Demote' : 'Promote'}</button>
                <button type="button" className="icon-button" aria-label={`Remove ${member.display_name || member.username}`} disabled={busy} onClick={() => removeMember(member)}><X size={15}/></button>
              </div>}
            </div>)}
          </div>
        </section>
        {meIsAdmin && <section className="group-members-section">
          <header className="group-section-heading"><strong>Add people</strong><UserPlus size={15}/></header>
          <label className="search-box group-search"><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find people to add"/></label>
          <div className="group-candidate-list">
            {candidates.slice(0, 6).map(person => {
              const chosen = selectedToAdd.includes(person.id)
              return <button type="button" className={`group-person ${chosen ? 'selected' : ''}`} key={person.id} onClick={() => {
                if (!chosen && selectedToAdd.length >= 30) {
                  setError('You can add up to 30 people at a time.')
                  return
                }
                setError('')
                setSelectedToAdd(items => chosen ? items.filter(id => id !== person.id) : [...items, person.id])
              }}>
                <Avatar name={person.display_name || person.username} seed={person.username} small avatarUrl={person.avatar_url} token={token}/>
                <span className="conversation-copy"><strong>{person.display_name || person.username}</strong><small>@{person.username}</small></span>
                <span className={`selection-check ${chosen ? 'checked' : ''}`}>{chosen && <Check size={13}/>}</span>
              </button>
            })}
            {candidates.length === 0 && <p className="empty-hint">{searching ? 'Searching people…' : search ? 'No people match your search.' : 'Everyone in your directory is already here.'}</p>}
          </div>
          {selectedToAdd.length > 0 && <button className="primary-button" type="button" disabled={busy} onClick={addMembers}>Add {selectedToAdd.length} member{selectedToAdd.length === 1 ? '' : 's'}</button>}
        </section>}
        <section className="group-members-section group-settings-section">
          <button type="button" className="group-setting-row" disabled={busy} onClick={() => updateSettings('is_muted', !group.is_muted)}><span>Mute notifications</span><span>{group.is_muted ? 'On' : 'Off'}</span></button>
          <button type="button" className="group-setting-row" disabled={busy} onClick={() => updateSettings('is_archived', !group.is_archived)}><span><Archive size={15}/> {group.is_archived ? 'Unarchive group' : 'Archive group'}</span><span>{group.is_archived ? 'On' : 'Off'}</span></button>
        </section>
        <button type="button" className="leave-group-button" disabled={busy} onClick={leave}><LogOut size={15}/> Leave group</button>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
    </section>
  </div>
}
