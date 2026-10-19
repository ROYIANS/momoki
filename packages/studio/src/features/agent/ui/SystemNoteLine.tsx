import type {ChatMessage} from "../models/chat";
import "./systemNote.css";

const MAX_LINE = 160;

/** A system input row in the conversation: one faint line, never a user bubble. */
export function SystemNoteLine({message}: {message: Pick<ChatMessage, "display" | "content" | "createdAt">}) {
    const text = (message.display?.trim() || message.content.trim()).replace(/\s+/g, " ");
    const characters = Array.from(text);
    const label = characters.length > MAX_LINE ? `${characters.slice(0, MAX_LINE).join("")}…` : text;
    const time = new Date(message.createdAt);
    return <div className="agent-transcript-item agent-system-note" role="note" aria-label="系统提示"
                data-agent-public="true" title={Number.isNaN(time.getTime()) ? undefined : time.toLocaleString()}>
        <span>{label}</span>
    </div>;
}
