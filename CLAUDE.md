# Linka repository rules

## Git: the owner commits manually

- Never create, make or amend commits (`git commit`, `git commit --amend`).
- Never push, and never create tags.
- Inspecting `git status`, `git diff` and `git log` is fine.
- When a phase is complete, stop and report the changes and verification results.

## Commit authorship

- Never add `Co-authored-by:` trailers for Claude, Anthropic, AI, or any other AI assistant.
- Do not add Claude/Anthropic attribution to commit messages.
- Do not modify the Git author identity.
- Commits use the configured Git `user.name` and `user.email` only.
- Keep commit messages normal and project-focused.
- Do not add any AI attribution unless explicitly asked for it.
