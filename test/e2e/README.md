# E2E tests (Issue #218)

No Docker Compose-based end-to-end suite exists yet. This directory is the
starting point: a full-stack E2E run should spin up the real app plus Redis
via `docker-compose`, then exercise it over actual HTTP with `supertest`
against the running server, rather than the in-process Express app used by
the existing integration tests.
