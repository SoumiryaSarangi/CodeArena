/** Shortcut catalogue: UI_UX §13. `mod` renders as ⌘ on macOS and Ctrl elsewhere. */
export interface Shortcut {
  keys: string[];
  action: string;
  scope: string;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: ['mod', 'K'], action: 'Command palette', scope: 'Global' },
  { keys: ['?'], action: 'Shortcut sheet', scope: 'Global' },
  { keys: ['g', 'h'], action: 'Go to Home', scope: 'Global' },
  { keys: ['g', 'p'], action: 'Go to Practice', scope: 'Global' },
  { keys: ['g', 'c'], action: 'Go to Contests', scope: 'Global' },
  { keys: ['g', 'i'], action: 'Go to Interview', scope: 'Global' },
  { keys: ['/'], action: 'Focus search', scope: 'Lists' },
  { keys: ['mod', 'Enter'], action: 'Run', scope: 'Workspace, room' },
  { keys: ['mod', 'Shift', 'Enter'], action: 'Submit', scope: 'Workspace, room' },
  { keys: ['Alt', '1…4'], action: 'Console / Tests / Submissions / Coach', scope: 'Workspace' },
  { keys: ['Alt', 'A…F'], action: 'Switch contest problem', scope: 'Arena' },
];

/** Where the `g` sequences go. */
export const GO_ROUTES: Record<string, string> = {
  h: '/home',
  p: '/practice',
  c: '/contests',
  i: '/interview',
};

export const NAV = [
  { href: '/home', label: 'Home', icon: 'home' },
  { href: '/practice', label: 'Practice', icon: 'code' },
  { href: '/contests', label: 'Contests', icon: 'trophy' },
  { href: '/interview', label: 'Interview', icon: 'users' },
  { href: '/profile', label: 'Profile', icon: 'user' },
] as const;
