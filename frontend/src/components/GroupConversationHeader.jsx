import { Users } from 'lucide-react'
import Avatar from './Avatar.jsx'

export default function GroupConversationHeader({ conversation, title, token, onOpenDetails }) {
  return <>
    <button className="chat-header-avatar" aria-label={`Open ${title} group details`} onClick={onOpenDetails}>
      <Avatar name={title} seed={title} group avatarUrl={conversation.avatar_url} token={token}/>
    </button>
    <button className="chat-heading chat-heading-button" onClick={onOpenDetails}>
      <h2>{title}</h2>
      <p><Users size={12}/>{conversation.member_count || conversation.members?.length || 0} members · {conversation.description || 'Group conversation'}</p>
    </button>
  </>
}
