import type { ProjectKind } from '../shared/types';

// 16px line icons, drawn with currentColor so they follow the text color they sit in.
const icon = (body: string) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  claude: icon('<path d="M8 2.2v11.6M2.2 8h11.6M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2"/>'),
  shell: icon('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M4.6 6.2 6.8 8l-2.2 1.8M8.4 10.2h3"/>'),
  branch: icon('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 2.6-2.2 3.4-6.2 4.3"/>'),
  tasks: icon('<path d="M7 4h6.5M7 8h6.5M7 12h6.5M2.3 4l1 1 1.7-2M2.3 8l1 1 1.7-2M2.3 12l1 1 1.7-2"/>'),
  sessions: icon('<rect x="1.8" y="2.5" width="12.4" height="4.5" rx="1.5"/><rect x="1.8" y="9" width="12.4" height="4.5" rx="1.5"/><path d="M4.6 4.75h.01M4.6 11.25h.01M7 4.75h4.4M7 11.25h4.4"/>'),
  pin: icon('<path d="M5.5 2.5h5M6.5 2.5v3.8L4.6 9h6.8L9.5 6.3V2.5M8 9v4.5"/>'),
  plus: icon('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  newProject: icon('<path d="M14 7.4V6.6A1.5 1.5 0 0 0 12.5 5.1H7.7L6.2 3.5H3.5A1.5 1.5 0 0 0 2 5v6.5A1.5 1.5 0 0 0 3.5 13h4.3M12 9.6v4.2M9.9 11.7h4.2"/>'),
  stop: icon('<rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.3"/>'),
  close: icon('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  more: icon('<path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.4"/>'),
  check: icon('<path d="M3.2 8.4 6.4 11.4 12.8 4.6" stroke-width="1.8"/>'),
  chevronRight: icon('<path d="M6 3.5 10.5 8 6 12.5" stroke-width="1.8"/>'),
  chevronDown: icon('<path d="M3.5 6 8 10.5 12.5 6" stroke-width="1.8"/>'),
  chat: icon('<path d="M2.5 4.2A1.7 1.7 0 0 1 4.2 2.5h7.6a1.7 1.7 0 0 1 1.7 1.7v5a1.7 1.7 0 0 1-1.7 1.7H7.2L4.4 13.3v-2.4h-.2a1.7 1.7 0 0 1-1.7-1.7z"/>'),
  unsplit: icon('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M8 2.8v10.4M10.2 6.6l1.7 1.4-1.7 1.4"/>'),
};

const GLYPHS = {
  folder: icon('<path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h2.7l1.5 1.6h4.8A1.5 1.5 0 0 1 14 6.6v4.9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>'),
  engine: icon('<path d="M8 1.8l5.5 3.1v6.2L8 14.2l-5.5-3.1V4.9z"/><path d="M2.5 4.9 8 8l5.5-3.1M8 8v6.2"/>'),
  code: icon('<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/>'),
};

/** Drawn on a project tab when the project has no icon of its own. */
export const KIND_GLYPH: Record<ProjectKind, string> = {
  unity: GLYPHS.engine,
  godot: GLYPHS.engine,
  apple: GLYPHS.code,
  node: GLYPHS.code,
  python: GLYPHS.code,
  rust: GLYPHS.code,
  go: GLYPHS.code,
  folder: GLYPHS.folder,
};
