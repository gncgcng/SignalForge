# CLAUDE.md

## Testing and databases

- Never run tests, migrations or seeds against the dev volume
  `build-a-modern-full-stack-web_signalforge-postgres` (the `build-a-modern-full-stack-web-postgres-1`
  container on port 5432) or against production.
- For any database work, start a throwaway docker compose project with its data on tmpfs and a separate
  host port, apply migrations there, and tear it down afterwards:

  ```yaml
  # throwaway-compose.yml (keep it outside the repo, e.g. in a scratch directory)
  services:
    postgres:
      image: postgres:16-alpine
      environment:
        POSTGRES_USER: signalforge
        POSTGRES_PASSWORD: signalforge
        POSTGRES_DB: signalforge
      ports:
        - "55432:5432"
      tmpfs:
        - /var/lib/postgresql/data
  ```

  ```bash
  docker compose -p signalforge-throwaway -f throwaway-compose.yml up -d
  export DATABASE_URL=postgres://signalforge:signalforge@localhost:55432/signalforge
  npm run db:migrate
  npm run test:<name>
  docker compose -p signalforge-throwaway -f throwaway-compose.yml down -v
  ```

- DB-backed test scripts import `scripts/test-support/require-local-database.js` first; it refuses a
  non-local `DATABASE_URL`, but it cannot tell the dev volume from a throwaway one, so pick the port yourself.
- The preview tool must serve the worktree you are working in and point at the throwaway database. If you
  change `.claude/launch.json` to do that, revert the change before you commit or finish.
- Never start the signalforge-local launch config (or any preview/launch entry that points at the dev DB).
  Browser checks must use a temporary launch entry pointing at the throwaway DB, and remove it afterwards.
