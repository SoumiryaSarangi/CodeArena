import { ProblemError } from '../../common/problem';
import type { AuthUser } from '../auth/guards';

/**
 * Who may manage a problem (setter screens, UI-04): an admin any problem, a setter only the ones
 * they authored. A problem imported from the CLI has no author, so only an admin manages it.
 */
export function assertCanManage(user: Pick<AuthUser, 'id' | 'role'>, authorId: string | null) {
  if (user.role === 'admin') return;
  if (user.role === 'setter' && authorId !== null && authorId === user.id) return;
  throw new ProblemError('forbidden', 'You can only manage problems you uploaded');
}
