# UI Console

React + Ant Design client for the AI Inference Platform.

## Features

- Route-based UI with two paths:
  - `/admin`: admin-only user creation panel
  - `/inference`: user/premium/enterprise inference workspace
- Login page (`/login`) with role-based redirect
- Admin can create users with role `user`, `premium`, or `enterprise` (`POST /auth/signup`)
- User/premium/enterprise can:
  - fetch and select models (`GET /models`)
  - submit inference (`POST /inference`)
  - check status (`GET /inference/:jobId`)
  - view their own historical inferences from backend job storage (owner-scoped)
  - sync history across all live inference racks using the UI `Sync History` action
  - open full prompt/result details in a modal from the history `Check` action

## Tech stack

- React 18 + Ant Design 5
- TypeScript + Vite

## Modular structure

- `src/pages`: route pages (`LoginPage`, `AdminPage`, `UserPage`)
- `src/components`: reusable UI components
- `src/lib`: auth/session/history utilities

## Run

1. Ensure `app-node` API is running on `http://localhost:3000`.
2. Install dependencies:

```sh
cd ui-console
npm install
```

3. Start dev server:

```sh
npm run dev
```

Type-check the project:

```sh
npm run typecheck
```

Lint the project:

```sh
npm run lint
```

The app runs on `http://localhost:5173`.

By default, the app calls API at `/api`, and Vite proxies `/api/*` to `http://localhost:3000` in development.

## Optional API base override

Set `VITE_API_BASE_URL` if you want to call a remote API directly:

```sh
VITE_API_BASE_URL=https://your-api-host/api npm run dev
```
