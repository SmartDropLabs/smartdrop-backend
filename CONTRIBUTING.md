# Contributing to SmartDrop Backend

Thank you for your interest in contributing! This document provides guidelines for setting up your development environment, writing code, running tests, and submitting pull requests.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Running Tests](#running-tests)
- [Code Style and Linting](#code-style-and-linting)
- [Database Migrations](#database-migrations)
- [Git Workflow](#git-workflow)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Commit Message Conventions](#commit-message-conventions)

## Getting Started

### Prerequisites

- **Node.js** 20.9.0 or higher
- **Docker** and **Docker Compose** (for running Redis and PostgreSQL locally)
- **Git**

### Clone the Repository

```bash
git clone https://github.com/SmartDropLabs/smartdrop-backend.git
cd smartdrop-backend
```

## Development Setup

### Option 1: Docker Compose (Recommended)

The fastest way to set up a complete development environment with Redis and PostgreSQL:

```bash
# Start all services (API, Redis, PostgreSQL)
docker-compose up

# In another terminal, install dependencies
npm install
```

The API will be available at `http://localhost:4000`. Hot-reload is enabled via Docker volumes.

**Services:**
- API: `http://localhost:4000`
- Redis: `localhost:6379`
- PostgreSQL: `localhost:5432` (user: `smartdrop`, password: `smartdrop`)

### Option 2: Local Development

If you prefer to run services locally:

```bash
# Install dependencies
npm install

# Start Redis (in a separate terminal)
redis-server

# Start PostgreSQL (or use a managed service)
# Set DATABASE_URL environment variable

# Run the development server
npm run dev
```

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Edit `.env` and set:
- `PORT=4000`
- `REDIS_HOST=localhost` (or your Redis host)
- `DATABASE_URL=postgres://user:password@localhost:5432/smartdrop`
- API keys for CoinGecko and CoinMarketCap (optional for development)

### Environment Variables

See `.env.example` for a complete list. Key variables:

- `NODE_ENV`: Set to `test` when running tests
- `REDIS_HOST`, `REDIS_PORT`: Redis connection
- `DATABASE_URL`: PostgreSQL connection string
- `COINGECKO_API_KEY`: Optional; used for price oracle
- `COINMARKETCAP_API_KEY`: Optional; used for price oracle

## Running Tests

### Unit and Integration Tests

```bash
# Run all tests
npm test

# Run tests for a specific file
npm test -- webhooks.routes.test.js

# Run tests matching a pattern
npm test -- --testNamePattern="rejects unknown"

# Watch mode (re-run on file changes)
npm test -- --watch
```

### Test Coverage

Tests cover:
- REST endpoint contracts
- Validation schemas
- Service logic (price oracle, webhooks, indexer)
- Database migrations
- Error handling

### Key Test Files

- `test/webhooks.routes.test.js` - Webhook endpoint tests
- `test/health.test.js` - Health check tests
- `test/api-docs.test.js` - OpenAPI spec validation
- `test/webhookEvents.test.js` - Event type validation
- `test/circuitBreaker.test.js` - Circuit breaker logic

## Code Style and Linting

### ESLint

A minimal ESLint config is provided to catch common issues. The config is lightweight by design (Issue #231).

```bash
# Lint all source files
npx eslint .

# Auto-fix fixable issues
npx eslint . --fix
```

**Current Rules:**
- `no-unused-vars`: warn

Feel free to propose additions to `.eslintrc.js` as the codebase evolves.

### OpenAPI Spec Linting

The OpenAPI specification is linted during CI to ensure it's valid and well-formed:

```bash
# Lint the OpenAPI spec
npx @redocly/cli lint openapi.yaml
```

### Code Style Expectations

- **Formatting**: 2-space indentation, use semicolons
- **Variable naming**: camelCase for variables and functions, snake_case for database columns
- **Comments**: Use JSDoc for complex functions; inline comments for non-obvious logic
- **Error handling**: Always provide descriptive error messages; include request IDs in logs

## Database Migrations

Migrations are managed via Knex.js. The migration system includes safeguards to prevent accidental schema changes in production.

### Running Migrations

```bash
# Apply pending migrations
npm run migrate

# Preview migrations without applying (dry run)
npm run migrate:dry-run

# Check migration status
npm run migrate:status

# Roll back the last batch of migrations
npm run migrate:rollback
```

### Writing Migrations

Migration files are in `src/db/migrations/`. To create a new migration:

```bash
npx knex migrate:make migration_name
```

**Example migration structure:**

```javascript
'use strict';

exports.up = async (knex) => {
  return knex.schema.createTable('my_table', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable();
    table.timestamps(true, true);
  });
};

exports.down = async (knex) => {
  return knex.schema.dropTable('my_table');
};
```

**Important:** Migrations run on production; test your rollback steps locally before submitting.

## Git Workflow

### Branching Strategy

- Create feature branches off `main`
- Use descriptive branch names: `feature/webhook-retry`, `fix/price-anomaly`, `docs/contributing`
- Keep branches focused on a single issue or feature

### Local Setup

```bash
# Ensure you're on the latest main
git checkout main
git pull origin main

# Create a new feature branch
git checkout -b feature/your-feature-name

# Make changes and commit
git add src/
git commit -m "feat: describe your change"

# Keep your branch up to date
git rebase origin/main
```

## Pull Request Guidelines

### Before Submitting a PR

1. **Tests pass locally**: Run `npm test` and ensure all tests pass
2. **Linting passes**: Run `npx eslint .` with no errors
3. **OpenAPI spec is valid**: Run `npx @redocly/cli lint openapi.yaml`
4. **Migrations tested**: If adding migrations, verify `npm run migrate` and `npm run migrate:rollback` work
5. **Code is documented**: Add comments for complex logic; update OpenAPI spec if endpoints change
6. **Branch is up to date**: Rebase on `main` if there are conflicts

### Creating a PR

1. Push your branch: `git push origin feature/your-feature-name`
2. Open a PR on GitHub with a clear title and description
3. Link any related issues: "Closes #123"

### PR Title Format

Use semantic commit prefixes:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation
- `refactor:` - Code refactoring (no behavior change)
- `test:` - Test additions or updates
- `perf:` - Performance improvements
- `chore:` - Build, CI, or dependency updates

Examples:
- `feat: add webhook signature verification`
- `fix: handle null issuer in price queries`
- `docs: improve CONTRIBUTING.md`

### PR Description

Include:

1. **What changed**: Describe the feature or bug fix
2. **Why**: Explain the motivation or problem being solved
3. **How to test**: Step-by-step instructions to verify the change
4. **Related issues**: Reference any GitHub issues
5. **Breaking changes**: Call out any backward-incompatible changes

**Example:**

```markdown
## Description
Adds webhook event type validation to prevent typos in subscription filters.

## Problem
Users could register webhooks with invalid event types (e.g., "foo.bar"), 
resulting in subscriptions that never fire.

## Solution
- Enhanced `webhookSubscriptionSchema` to validate against known event types
- Improved error messages to show which events are invalid and what's valid

## Testing
1. Open Swagger UI at /api-docs
2. POST /api/v1/webhooks with events: ["invalid.event"]
3. Verify 400 response with helpful error message listing valid events

Closes #123
```

## Commit Message Conventions

Commits should follow the conventional commits format for consistency with automated changelog generation:

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `test`: Adding missing or correcting tests
- `perf`: A code change that improves performance
- `chore`: Changes to build process, dependencies, or CI configuration

### Scope (Optional)

Scope clarifies what part of the codebase is affected:

- `webhooks`
- `prices`
- `indexer`
- `auth`
- `migrations`
- `tests`
- `api-docs`

### Examples

```bash
git commit -m "feat(webhooks): add event type validation"
git commit -m "fix(prices): handle null issuer in circuit breaker"
git commit -m "docs(contributing): add development setup guide"
git commit -m "test(auth): improve API key middleware coverage"
git commit -m "refactor(cache): simplify Redis connection logic"
```

## CI/CD Pipeline

All commits to `main` and pull requests automatically trigger:

1. **Lint OpenAPI spec** - Validates `openapi.yaml`
2. **Lint source code** - ESLint checks (warnings do not block)
3. **Run tests** - Full test suite with Redis available
4. **Test migrations** - Ensures migrations run and rollback cleanly
5. **Build Docker image** - Verifies the production Docker image builds

A PR must pass all required checks before it can be merged.

## Troubleshooting

### Tests fail with "Redis connection refused"

Ensure Redis is running:

```bash
# If using Docker Compose
docker-compose up -d redis

# If using local Redis
redis-server
```

### Database migration errors

Check that PostgreSQL is running and the `DATABASE_URL` is correct:

```bash
echo $DATABASE_URL
psql $DATABASE_URL -c "SELECT 1"
```

### Port already in use

If port 4000 (API), 6379 (Redis), or 5432 (PostgreSQL) are in use:

```bash
# Option 1: Kill the process
lsof -ti:4000 | xargs kill -9

# Option 2: Use different ports
PORT=4001 npm run dev
REDIS_PORT=6380 redis-server
```

### Node version mismatch

Verify you're using Node 20.9.0 or higher:

```bash
node --version  # Should be v20.9.0+

# Use nvm to switch versions
nvm install 20
nvm use 20
```

## Getting Help

- **Questions**: Open a GitHub Discussion
- **Bug reports**: Open a GitHub Issue with reproduction steps
- **Security issues**: Email security@smartdrop.app (do not open a public issue)

## Code of Conduct

Be respectful and inclusive. We're all here to build something great together.

---

**Thank you for contributing to SmartDrop!** 🎉
