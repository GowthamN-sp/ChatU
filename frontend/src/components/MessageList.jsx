import { AnimatePresence, motion } from 'framer-motion'
import { CheckCheck, MessageCircle, Paperclip } from 'lucide-react'
import Avatar from './Avatar.jsx'

const timeLabel = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

export default function MessageList({
  conversation,
  title,
  messages,
  currentUserId,
  token,
  bottomRef,
  hasOlder,
  loadingOlder,
  typingUsers,
  onLoadOlder,
  onOpenProfile,
  onDownloadAttachment
}) {
  const isGroup = conversation.is_group
  return <div className="message-scroll">
    {hasOlder && <button className="load-older-button" type="button" onClick={onLoadOlder} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>}
    {messages.length === 0 && <div className="empty-chat"><div className="empty-illustration"><MessageCircle size={30}/><span>✦</span></div><h3>A fresh little beginning</h3><p>Say hello to {title}. Good things start with one message.</p></div>}
    <AnimatePresence initial={false}>{messages.map((message, index) => {
      if (message.is_system) return <motion.div key={message.id} className="group-system-message" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}><span>{message.body}</span><small>{timeLabel(message.created_at)}</small></motion.div>
      const mine = message.sender_id === currentUserId
      const sender = conversation.members?.find(member => member.id === message.sender_id)
      const previous = messages[index - 1]
      const firstFromSender = isGroup && (!previous || previous.sender_id !== message.sender_id)
      return <motion.div key={message.id} className={`message-row ${mine ? 'mine' : 'theirs'}`} initial={{ opacity: 0, y: 10, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: .22, delay: Math.min(index * .01, .12) }}>
        {!mine && (!isGroup || firstFromSender) && <span className="avatar-action" role="button" tabIndex={0} aria-label={`View ${sender?.display_name || 'sender'} profile`} onClick={() => onOpenProfile(message.sender_id)} onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpenProfile(message.sender_id)
          }
        }}><Avatar name={sender?.display_name || title} seed={sender?.username || title} small avatarUrl={sender?.avatar_url} token={token}/></span>}
        <div className="message-content">
          {isGroup && !mine && firstFromSender && <strong className="group-sender-name">{sender?.display_name || sender?.username || 'Member'}</strong>}
          {(message.body || message.attachment_url) && <div className="message-bubble">
            {message.body}
            {message.attachment_url && <button className="attachment-link" type="button" onClick={() => onDownloadAttachment(message)}><Paperclip size={13}/>{message.attachment_name || 'Download attachment'}</button>}
          </div>}
          <div className="message-meta">{timeLabel(message.created_at)} {message.edited_at && <span className="edited-label">edited</span>} {mine && <CheckCheck size={13}/>}</div>
        </div>
      </motion.div>
    })}</AnimatePresence>
    {typingUsers.length > 0 && <motion.div className="typing-row" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}><span className="typing-bubble"><i/><i/><i/></span><small>Someone is typing</small></motion.div>}
    <div ref={bottomRef}/>
  </div>
}
