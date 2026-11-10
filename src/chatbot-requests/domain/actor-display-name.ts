/**
 * The copied display name of a staff actor on a request and its events.
 * `User.name` can be empty, and the code's own guard (an assignee or actor
 * with an empty name counts as no actor) used to reject such a user, so the
 * value falls back to the email local part and finally to a fixed label. Never
 * empty.
 */
export const FALLBACK_ACTOR_NAME = 'Usuario';

export function actorDisplayName(user: {
  name: string;
  email: string;
}): string {
  const name = user.name.trim();
  if (name.length > 0) return name;
  const local = user.email.split('@')[0]?.trim() ?? '';
  return local.length > 0 ? local : FALLBACK_ACTOR_NAME;
}
