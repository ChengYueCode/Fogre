# AGENTS.md

## Validation and distribution

Before changing distribution or public documentation, read `docs/release-checklist.md` and `docs/skill-architecture.md`. Change capability rules in `skill/forge/`, then regenerate standalone entries with `npm run build:entries`. Run `npm run check:links` and `npm test`; report failures and skipped historical-tool checks separately. Create release candidates through `npm run prepare:release`, then verify their manifests. Public source, personal skill installation, host invocation, and remote publication are separate delivery states.

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to same-named labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
