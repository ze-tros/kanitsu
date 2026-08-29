# Repository Guidelines

## Project Structure & Module Organization

This repository is an npm workspace monorepo for Kanitsu, a local-first image viewer. Application shells live in `apps/`: `web` contains the Vite/React entry point, `desktop` contains Electron main/preload code, and `mobile` contains the Capacitor Android project. Reusable TypeScript modules live in `packages/`: `core` owns library operations and domain types, `fs-adapter` abstracts storage, `organizer` and `cover-picker` provide focused features, `image-pipeline` defines image processing, and `ui` contains shared React components. Unit tests are colocated in each package's `test/` directory. Design notes and prototypes belong in `docs/`; Android resources remain under `apps/mobile/android/app/src/main/res/`.

## Build, Test, and Development Commands

- `npm install`: install all workspace dependencies from the lockfile.
- `npm run dev:web`: start the Vite web development server.
- `npm run dev:desktop`: compile Electron code and launch the desktop development environment.
- `npm run build:web`: type-check and build the web application into `apps/web/dist/`.
- `npm run build:mobile`: build the web bundle and sync it into the Android project.
- `npm run typecheck`: run TypeScript checks across all workspaces.
- `npm test --workspaces --if-present`: run package tests, including `core` and `fs-adapter`.

Run commands from the repository root unless debugging one workspace directly.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules. Follow the existing two-space indentation, single quotes, semicolons, and trailing commas in multiline declarations. Use `PascalCase` for React components and exported classes/types, `camelCase` for functions and variables, and descriptive lowercase filenames for domain modules (`scan.ts`, `organize.ts`). Component filenames may use `PascalCase.tsx`. Keep platform-specific behavior behind adapters rather than branching throughout shared packages. No formatter or linter is configured, so match nearby code and finish with `npm run typecheck`.

## Testing Guidelines

Tests use Node's built-in `node:test` with `node:assert/strict`. Name files `<feature>.test.ts` and place them under the owning package's `test/` directory. Cover success paths, persistence or filesystem edge cases, and regressions for changed behavior. There is no enforced coverage percentage; meaningful behavioral assertions are expected. Android JVM tests live under `apps/mobile/android/app/src/test/`.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits with optional scopes, for example `feat(mobile): ...` and `fix(android): ...`. Keep commits focused and use an imperative summary. Pull requests should explain the user-visible change, list verification commands, link relevant issues, and include screenshots or recordings for UI changes. Call out platform-specific effects, migrations, or new configuration explicitly.
