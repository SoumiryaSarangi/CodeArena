import type { Language } from '@codearena/contracts';

export interface LanguageInfo {
  id: Language;
  label: string;
  /** Monaco's language id. */
  monaco: string;
  /** What the editor starts with (and what Reset restores). */
  template: string;
}

export const LANGUAGES: LanguageInfo[] = [
  {
    id: 'cpp17',
    label: 'C++17',
    monaco: 'cpp',
    template:
      '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n',
  },
  {
    id: 'cpp20',
    label: 'C++20',
    monaco: 'cpp',
    template:
      '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n',
  },
  {
    id: 'c',
    label: 'C',
    monaco: 'c',
    template: '#include <stdio.h>\n\nint main(void) {\n    \n    return 0;\n}\n',
  },
  {
    id: 'python3',
    label: 'Python 3',
    monaco: 'python',
    template: 'import sys\n\n\ndef main():\n    pass\n\n\nmain()\n',
  },
  {
    id: 'java21',
    label: 'Java 21',
    monaco: 'java',
    template:
      'import java.util.*;\nimport java.io.*;\n\npublic class Main {\n    public static void main(String[] args) throws IOException {\n        \n    }\n}\n',
  },
  {
    id: 'node',
    label: 'JavaScript (Node.js)',
    monaco: 'javascript',
    template: "const lines = require('fs').readFileSync(0, 'utf8').split('\\n');\n\n",
  },
];

export const languageInfo = (id: string): LanguageInfo =>
  LANGUAGES.find((l) => l.id === id) ?? LANGUAGES[0]!;

export const isLanguage = (v: unknown): v is Language => LANGUAGES.some((l) => l.id === v);
