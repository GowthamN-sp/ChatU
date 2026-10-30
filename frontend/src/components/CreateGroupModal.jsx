import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Check, Search, X } from 'lucide-react'
import Avatar from './Avatar.jsx'

const VALID_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

export default function CreateGroupModal({ users, token, request, onClose, onCreated, onError }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState([])
  const [photo, setPhoto] = useState(null)
  const [photoPreview, setPhotoPreview] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const creationKey = useRef(globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.random() * 16 | 0
    return (character === 'x' ? value : value & 0x3 | 0x8).toString(16)
  }))
  const people = search.trim() ? (searchResults || []) : users

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

  useEffect(() => () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview)
  }, [photoPreview])

  function selectPhoto(file) {
    if (!file) return
    if (!VALID_IMAGE_TYPES.includes(file.type)) {
      setError('Choose a JPEG, PNG, WebP, or GIF image.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Group photos must be 5 MB or smaller.')
      return
    }
    setPhoto(file)
    setPhotoPreview(URL.createObjectURL(file))
    setError('')
  }

  async function create(event) {
    event.preventDefault()
    if (!name.trim()) {
      setError('Add a group name to continue.')
      return
    }
    if (selected.length < 2) {
      setError('Choose at least two other members.')
      return
    }
    setSaving(true)
    setError('')
    try {
      let conversation = await request(`/api/conversations?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': creationKey.current },
        body: JSON.stringify({
          member_ids: selected.map(person => person.id),
          title: name.trim(),
          description: description.trim(),
          is_group: true
        })
      })
      onCreated(conversation)
      if (photo) {
        const form = new FormData()
        form.append('file', photo)
        try {
          conversation = await request(`/api/conversations/${conversation.id}/avatar?token=${encodeURIComponent(token)}`, {
            method: 'POST',
            body: form
          })
          onCreated(conversation)
        } catch (uploadError) {
          onError(`Group created, but its photo could not be saved: ${uploadError.message}`)
        }
      }
      onClose()
    } catch (requestError) {
      setError(requestError.message)
      setSaving(false)
    }
  }

  function close() {
    if (!saving) onClose()
  }

  return <div className="group-overlay" onClick={close}>
    <section className="group-dialog" role="dialog" aria-modal="true" aria-labelledby="create-group-title" onClick={event => event.stopPropagation()}>
      <header className="group-dialog-header">
        <div><span className="eyebrow">A SPACE FOR YOUR PEOPLE</span><h2 id="create-group-title">Create a group</h2></div>
        <button type="button" className="icon-button" aria-label="Close create group" onClick={close} disabled={saving}><X size={18}/></button>
      </header>
      <form className="group-form" onSubmit={create}>
        <div className="group-photo-row">
          <label className="group-photo-picker" htmlFor="new-group-photo">
            {photoPreview
              ? <img src={photoPreview} alt="Group photo preview"/>
              : <><Camera size={20}/><span>Add photo</span></>}
          </label>
          <input id="new-group-photo" className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={event => { selectPhoto(event.target.files?.[0]); event.target.value = '' }}/>
          <div className="group-photo-copy"><strong>Give your group a face</strong><small>Optional · JPEG, PNG, WebP or GIF up to 5 MB</small></div>
        </div>
        <label className="profile-field">Group name
          <input value={name} onChange={event => setName(event.target.value)} maxLength={120} placeholder="e.g. Weekend plans" required/>
        </label>
        <label className="profile-field">Description <span className="muted">(optional)</span>
          <textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={500} placeholder="What is this group for?"/>
        </label>
        <div className="group-member-heading"><strong>Add members</strong><span>{selected.length} selected</span></div>
        {selected.length > 0 && <div className="selected-members" aria-label="Selected members">
          {selected.map(person => <button type="button" key={person.id} className="selected-member" onClick={() => setSelected(current => current.filter(item => item.id !== person.id))}>
            <Avatar name={person.display_name || person.username} seed={person.username} small avatarUrl={person.avatar_url} token={token}/>
            <span>{person.display_name || person.username}</span><X size={13}/>
          </button>)}
        </div>}
        <label className="search-box group-search"><Search size={16}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search people"/></label>
        <div className="group-people-list">
          {people.map(person => {
            const isSelected = selected.some(item => item.id === person.id)
            return <button type="button" key={person.id} className={`group-person ${isSelected ? 'selected' : ''}`} onClick={() => {
              if (!isSelected && selected.length >= 30) {
                setError('A group can include up to 30 invited members.')
                return
              }
              setError('')
              setSelected(current => isSelected ? current.filter(item => item.id !== person.id) : [...current, person])
            }}>
              <Avatar name={person.display_name || person.username} seed={person.username} avatarUrl={person.avatar_url} token={token}/>
              <span className="conversation-copy"><strong>{person.display_name || person.username}</strong><small>@{person.username}</small></span>
              <span className={`selection-check ${isSelected ? 'checked' : ''}`}>{isSelected && <Check size={14}/>}</span>
            </button>
          })}
          {people.length === 0 && <p className="empty-hint">{searching ? 'Searching people…' : search ? 'No people match your search.' : 'No other users are available yet.'}</p>}
        </div>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="group-form-actions">
          <button type="button" className="soft-button" onClick={close} disabled={saving}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>{saving ? 'Creating…' : 'Create group'} <span>↗</span></button>
        </div>
      </form>
    </section>
  </div>
}
