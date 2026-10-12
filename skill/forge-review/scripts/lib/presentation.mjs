import { EmberError, CODES, isRecord } from './errors.mjs';

// Forge-authored palettes. Selection describes a learning task, never mastery.
export const THEMES = Object.freeze({
  atlas: { label: '关系探索', bg: '#f1f5fa', card: '#ffffff', soft: '#e8eff7', ink: '#172b43', muted: '#50637a', line: '#bdcbdc', accent: '#2857a4', nodes: ['#dae6fa', '#edf2fb', '#ffffff'], columns: '1.65fr 1fr', radius: '14px' },
  lab: { label: '参数实验', bg: '#edf6f5', card: '#ffffff', soft: '#e0efed', ink: '#173a3c', muted: '#466768', line: '#aecbc8', accent: '#006c68', nodes: ['#cce9e3', '#e4f3ef', '#ffffff'], columns: '1fr 1.3fr', radius: '8px' },
  sequence: { label: '过程推演', bg: '#f3f1fa', card: '#ffffff', soft: '#ece7f7', ink: '#302348', muted: '#68577d', line: '#c8bddb', accent: '#6940a5', nodes: ['#e2d6f4', '#f0eafa', '#ffffff'], columns: '1.25fr 1fr', radius: '6px' },
  contrast: { label: '概念对照', bg: '#faf2f1', card: '#ffffff', soft: '#f5e6e3', ink: '#472a2b', muted: '#7b5557', line: '#dbbdb8', accent: '#a13f48', nodes: ['#f3d7d4', '#faece9', '#ffffff'], columns: '1fr 1fr', radius: '10px' },
  editorial: { label: '精读与解释', bg: '#f5f4f0', card: '#ffffff', soft: '#ebeae4', ink: '#30362c', muted: '#62685b', line: '#c7cabd', accent: '#526530', nodes: ['#e1e7d3', '#eff2e8', '#ffffff'], columns: '1fr 1.4fr', radius: '3px' },
});

export function normalizePresentation(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw) || typeof raw.theme !== 'string' || !Object.hasOwn(THEMES, raw.theme)) {
    throw new EmberError(CODES.SCHEMA, 'presentation.theme 必须是 atlas/lab/sequence/contrast/editorial', 'presentation.theme');
  }
  if (raw.rationale !== undefined && (typeof raw.rationale !== 'string' || !raw.rationale.trim())) {
    throw new EmberError(CODES.SCHEMA, 'presentation.rationale 需要非空设计依据或省略', 'presentation.rationale');
  }
  return { theme: raw.theme, ...(raw.rationale === undefined ? {} : { rationale: raw.rationale.trim() }) };
}

export function resolvePresentation(model) {
  const explicit = normalizePresentation(model.presentation);
  const kinds = new Set((model.interactions ?? []).map((item) => item.kind));
  const name = explicit?.theme ?? (kinds.has('parameter') ? 'lab'
    : kinds.has('step-through') ? 'sequence'
    : kinds.has('comparison') || (model.relations ?? []).some((r) => r.type === 'contrast') ? 'contrast'
    : 'atlas');
  return { name, ...THEMES[name] };
}

export function presentationCss(model) {
  const t = resolvePresentation(model);
  return `/* Forge presentation: ${t.name} */
  :root { --bg:${t.bg}; --bg-2:${t.bg}; --card:${t.card}; --card-2:${t.soft};
    --ink:${t.ink}; --ink-soft:${t.muted}; --ink-faint:${t.muted}; --line:${t.line}; --line-strong:${t.line};
    --accent:${t.accent}; --accent-soft:${t.nodes[0]}; --blue:${t.accent}; --radius:${t.radius};
    --green:#236044; --green-soft:#e3f2e9; --amber:#805200; --amber-soft:#fff1cf; --red:#a32b35; --red-soft:#fde8eb;
    --relation-prerequisite:#2857a4; --relation-cause:#805200; --relation-contrast:#a13f48; --relation-application:#236044;
    --focus:0 0 0 3px ${t.accent}; --shadow:0 3px 16px #172b430a; }
  body { background:var(--bg); }
  .topbar { background:var(--card); border:0; border-top:4px solid var(--accent); padding:22px 20px; }
  .brand { color:var(--accent); letter-spacing:.2em; }
  #docTitle { font-size:clamp(23px,2.7vw,34px); letter-spacing:-.025em; }
  button.primary, .chip[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); }
  button.primary:hover { background:var(--ink); border-color:var(--ink); }
  .card, .prompt-item { border-radius:var(--radius); }
  .graph { background:var(--bg); }
  .node { border-radius:var(--radius); background:var(--card); }
  .node.depth-0 { background:${t.nodes[0]}; border-color:var(--accent); }
  .node.depth-1 { background:${t.nodes[1]}; }
  .node.depth-2, .node.depth-3 { background:${t.nodes[2]}; }
  .node.selected { border-color:var(--accent); box-shadow:0 0 0 2px var(--line-strong); }
  .hier-edge { stroke:var(--line-strong); }
  .rel-label { background:var(--card); }
  .badge { border-color:var(--line); }
  .m-unknown { background:var(--card-2); color:var(--ink-soft); }
  .m-pending, .pill.assisted, .q-needs, .banner-warn { color:var(--amber); }
  .m-explained, .m-applied, .m-retained { color:var(--green); }
  .m-applied, .m-retained { background:var(--green-soft); }
  @media (min-width:921px) { .layout { grid-template-columns:minmax(0,${t.columns.split(' ')[0]}) minmax(330px,${t.columns.split(' ')[1]}); } }
  ${t.name === 'sequence' ? '.graph { background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px); background-size:32px 32px; }' : ''}
  ${t.name === 'editorial' ? '#docTitle { font-family:"Noto Serif SC","Songti SC",SimSun,serif; } .panel { line-height:1.85; } .card { border-width:0 0 1px; box-shadow:none; }' : ''}
  ${t.name === 'lab' ? '.graph-toolbar, .tabs { border-top:2px solid var(--accent); } input[type="number"] { font-variant-numeric:tabular-nums; }' : ''}
  ${t.name === 'contrast' ? '.topbar { border-top:0; border-left:5px solid var(--accent); }' : ''}
  `;
}
