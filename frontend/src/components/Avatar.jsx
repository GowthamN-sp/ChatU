import { useEffect, useState } from 'react'
import { Users } from 'lucide-react'

const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
const initials = (name = '?') => name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase()

export default function Avatar({ name, seed = name, group = false, small = false, avatarUrl = null, token = '', preview = '', zoom = 1 }) {
  const [imageSource, setImageSource] = useState(preview)
  const [imageFailed, setImageFailed] = useState(false)
  const palettes = [['#f8d8b5','#b55f32'], ['#dce7c5','#58734b'], ['#f4c6cb','#a65067'], ['#c9dcf6','#426b9d'], ['#e6d4f5','#8454a7'], ['#f6e1a7','#a77626']]
  const paletteIndex = [...String(seed || name || '?')].reduce((value, character) => value + character.charCodeAt(0), 0) % palettes.length
  useEffect(() => {
    setImageFailed(false)
    if (preview) {
      setImageSource(preview)
      return undefined
    }
    if (!avatarUrl || !token) {
      setImageSource('')
      return undefined
    }
    const controller = new AbortController()
    let objectUrl = ''
    setImageSource('')
    fetch(`${API}${avatarUrl}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    }).then(response => {
      if (!response.ok) throw new Error(`Avatar request failed (${response.status})`)
      return response.blob()
    }).then(blob => {
      objectUrl = URL.createObjectURL(blob)
      if (!controller.signal.aborted) setImageSource(objectUrl)
    }).catch(() => {
      if (!controller.signal.aborted) setImageSource('')
    })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [avatarUrl, token, preview])
  const source = preview || imageSource
  return <span
    className={`avatar ${small ? 'avatar-small' : ''} ${source ? 'has-photo' : ''}`}
    style={{ '--avatar-bg': palettes[paletteIndex][0], '--avatar-ink': palettes[paletteIndex][1] }}
  >
    {source && !imageFailed
      ? <img src={source} alt="" style={preview ? { transform: `scale(${zoom})` } : undefined} onError={() => setImageFailed(true)}/>
      : group ? <Users size={small ? 13 : 17}/> : initials(name)}
  </span>
}
