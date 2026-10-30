import { motion } from 'framer-motion'
import { CheckCheck, VolumeX } from 'lucide-react'
import Avatar from './Avatar.jsx'

const timeLabel = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

export default function ConversationItem({ conversation, index, currentUserId, active, token, onSelect, onOpenProfile, onOpenDetails }) {
  const others = conversation.members?.filter(member => member.id !== currentUserId) || []
  const title = conversation.title || others.map(member => member.display_name || member.username).join(', ')
  const openInfo = event => {
    event.stopPropagation()
    if (conversation.is_group) onOpenDetails(conversation)
    else if (others[0]) onOpenProfile(others[0].id)
  }
  const handleInfoKey = event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openInfo(event)
    }
  }

  return <motion.button
    className={`conversation-item ${active ? 'active' : ''}`}
    onClick={() => onSelect(conversation)}
    initial={{ opacity: 0, x: -8 }}
    animate={{ opacity: 1, x: 0 }}
    transition={{ delay: index * .025 }}
  >
    <span className="avatar-action" role="button" tabIndex={0} aria-label={conversation.is_group ? `Open ${title} details` : `View ${title || 'conversation'} profile`} onClick={openInfo} onKeyDown={handleInfoKey}>
      <Avatar name={title || 'Group'} seed={conversation.is_group ? title : others[0]?.username || title} group={conversation.is_group} avatarUrl={conversation.is_group ? conversation.avatar_url : others[0]?.avatar_url} token={token}/>
    </span>
    <span className="conversation-copy">
      <strong>{title || 'New conversation'}</strong>
      <small>{conversation.last_message?.body || (conversation.is_group ? `${conversation.member_count || conversation.members?.length || 0} members` : 'Say hello 👋')}</small>
    </span>
    <span className="conversation-meta">
      <small>{timeLabel(conversation.last_message?.created_at)}</small>
      {conversation.is_muted && <VolumeX size={12}/>}
      {conversation.unread_count > 0
        ? <span className="unread-badge">{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</span>
        : conversation.last_message && <span className="mini-check"><CheckCheck size={13}/></span>}
    </span>
  </motion.button>
}
