import { scanKeywords } from "../core/scam_lexicon";
import { hasContactSignal } from "./contacts";
import type { CommentEntry, ReplyEntry } from "./snapshot";

/** Candidate discovery, not a fraud verdict. Scan every captured node before limiting depth. */
export function isCommentCandidate(node: CommentEntry | ReplyEntry): boolean {
  return ("is_pinned" in node && node.is_pinned === true) || ("is_up" in node && node.is_up === true) ||
    hasContactSignal(node.message) || scanKeywords(node.message).length > 0 ||
    /诈骗|骗子|骗局|举报|澄清|假冒|冒充|别信|不要信|不要转账|别转账|假的|辟谣/.test(node.message);
}

/** Keep candidate nodes, unambiguous ancestors and direct responses (including rebuttals). */
export function requiredReplies(root: CommentEntry): Set<ReplyEntry> {
  const replies = root.replies ?? [];
  const byId = new Map<string, ReplyEntry[]>();
  for (const reply of replies) {
    const id = reply.rpid?.trim();
    if (id) byId.set(id, [...(byId.get(id) ?? []), reply]);
  }
  const selected = new Set(replies.filter(isCommentCandidate));
  for (const reply of replies) {
    const parent = reply.parent?.trim();
    if (!parent) continue;
    if (root.rpid?.trim() === parent && isCommentCandidate(root)) selected.add(reply);
    else if (byId.get(parent)?.length === 1 && isCommentCandidate(byId.get(parent)![0]!)) selected.add(reply);
  }
  for (const reply of [...selected]) {
    const seen = new Set<ReplyEntry>();
    let current = reply;
    while (!seen.has(current)) {
      seen.add(current);
      const parent = current.parent?.trim();
      if (!parent || parent === root.rpid?.trim()) break;
      const parents = byId.get(parent);
      if (parents?.length !== 1) break;
      current = parents[0]!;
      selected.add(current);
    }
  }
  return selected;
}

/** Round-robin across snapshot order, recent comments and popularity; deterministic, no random seed. */
export function ordinaryCommentOrder(comments: readonly CommentEntry[]): number[] {
  const indexes = comments.map((_, index) => index);
  const lanes = [indexes, [...indexes].sort((a, b) => (comments[b]!.t ?? 0) - (comments[a]!.t ?? 0)),
    [...indexes].sort((a, b) => (comments[b]!.like ?? 0) - (comments[a]!.like ?? 0))];
  const seen = new Set<number>();
  for (let i = 0; i < indexes.length; i++) for (const lane of lanes) seen.add(lane[i]!);
  return [...seen];
}
