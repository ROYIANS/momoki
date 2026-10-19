import type {ChatMessage} from "../models/chat";

export type ChatTurn = { id: string; question: string; answer: string };
/** Keep the rail out of short conversations; compact rail caps visible marks without virtualizing. */
export const MIN_TURNS_FOR_NAVIGATION = 5;
export const MAX_VISIBLE_TURNS = 10;

/** A readable plain-text excerpt: never mount rich markdown in the navigation rail. */
export function turnExcerpt(text: string, limit = 160): string {
    const plain = text
        .replace(/```[^\n]*\n?[\s\S]*?```/g, " [代码] ")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, "")
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, " ").trim();
    const characters = Array.from(plain);
    return characters.length > limit ? characters.slice(0, limit).join("") + "…" : plain;
}

/** A user message owns all assistant attempts until the next user message. */
export function buildChatTurns(messages: readonly ChatMessage[]): ChatTurn[] {
    const turns: ChatTurn[] = [];
    for (const message of messages) {
        if (message.role === "user") {
            // A system event row (adoption, continuation) is not a question the reader asked.
            if (message.origin === "system") continue;
            turns.push({id: message.id, question: turnExcerpt(message.content, 120) || "附件消息", answer: "等待答复"});
        } else if (message.role === "assistant" && turns.length) {
            // The newest retry is the current answer; never mix another turn's text into its preview.
            turns[turns.length - 1].answer = turnExcerpt(message.content) || (
                message.status === "streaming" || message.status === "pending" ? "正在处理…"
                    : message.status === "error" ? "本次答复失败"
                        : message.status === "aborted" ? "已停止"
                            : message.status === "interrupted" ? "已暂停" : "暂无文字答复"
            );
        }
    }
    return turns;
}

/** Last turn starting above the reading line; a long answer remains in its own turn. */
export function getActiveTurnIndex(offsets: readonly number[], readingPosition: number): number {
    if (!offsets.length) return -1;
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (offsets[middle] <= readingPosition) low = middle;
        else high = middle - 1;
    }
    return low;
}
