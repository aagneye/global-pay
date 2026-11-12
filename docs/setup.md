# Development setup

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Flutter | 3.32+ (Dart 3.8+) | Mobile app |
| Android Studio + SDK cmdline-tools | latest | Android builds and emulator |
| Node.js | 22+ | Backend |
| Docker | latest | Local Postgres |
| Git | latest | — |
| Java | 17+ | OpenAPI client generator (iteration 5) |
| Foundry | latest | Contracts (from iteration 2) |

iOS builds need a Mac with Xcode. The project targets Android first.

## 1. Android toolchain

1. In Android Studio, open **Settings → Languages & Frameworks → Android SDK → SDK Tools**, tick **Android SDK Command-line Tools**, and apply.
2. Accept the SDK licences, then check the setup:

```bash
flutter doctor --android-licenses
```

```bash
flutter doctor
```

## 2. Database

```bash
docker compose up -d
```

This starts Postgres 17 on `localhost:5432` (user, password and database are all `globalpay`; local use only).

**Port 5432 already taken?** If you already run Postgres locally, put `POSTGRES_PORT=5433` in a `.env` file at the repo root, run `docker compose up -d` again, and use port 5433 in `services/api/.env`.

**No Docker?** Prisma can run a local Postgres for you. From `services/api`:

```bash
npx prisma dev
```

It prints a `postgres://` URL (the **TCP** one); put it in `DATABASE_URL`. It's for development only.

## 3. Backend: `services/api`

```bash
cd services/api
npm install
cp .env.example .env
npm run db:migrate
npm run typecheck
npm test
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`. Set `JWT_SECRET` in `.env` before starting.

- `npm install` also generates the Prisma client.
- `npm run db:migrate` creates the tables in `DATABASE_URL`.
- The API docs are at `http://localhost:3000/docs`.
- Quotes need a settlement contract. For local development, deploy one to anvil (section 4) and use the "Local chain instead" block in `.env.example`.
- With no network, set `RATE_SOURCE=fixed` to use `FIXED_USDC_THB_RATE` instead of Coinbase's public rates.

Payments, balance and history return `501 Not Implemented` until iteration 4. [services/api/README.md](../services/api/README.md) walks through a quote end to end.

## 4. Contracts: `contracts/`

Install Foundry with its official installer. On Windows, run this in Git Bash (or use WSL):

```bash
curl -L https://foundry.paradigm.xyz | bash
```

```bash
~/.foundry/bin/foundryup
```

The installer puts `forge`, `cast` and `anvil` in `%USERPROFILE%\.foundry\bin`, but doesn't add that folder to your PATH. Add it yourself.

**Check you're running the right `forge`:** another `forge` command, such as Atlassian's `@forge/cli` from npm, can shadow Foundry's. Run `forge --version`; the output should mention Foundry. If it doesn't, either:
- put `%USERPROFILE%\.foundry\bin` **before** `%APPDATA%\npm` in your PATH; or
- uninstall `@forge/cli` if you don't use it.

The libraries (forge-std, OpenZeppelin) are git submodules. Fetch them after cloning:

```bash
git submodule update --init
```

Don't add `--recursive`. OpenZeppelin's own test dependencies aren't needed, and their long file paths can make the clone fail on Windows.

Then:

```bash
cd contracts
forge build
forge test
```

To run a local chain with the contracts deployed, see [contracts/README.md](../contracts/README.md#local-chain-anvil).

## 5. Mobile app: `apps/mobile`

```bash
cd apps/mobile
flutter pub get
flutter analyze
flutter test
flutter run
```

The app reads its settings from `--dart-define` values:

| Key | Default | Notes |
|---|---|---|
| `API_BASE_URL` | `http://10.0.2.2:3000` | `10.0.2.2` is your computer, as seen from the Android emulator |
| `CHAIN_ID` | `84532` | Base Sepolia |
| `EXPLORER_URL` | `https://sepolia.basescan.org` | Used for transaction links |

Example:

```bash
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

## Keys and secrets

- Use **testnet keys only**. Each package keeps them in its own gitignored `.env`.
- Only `.env.example` files are committed.
- Never paste a mainnet key into this project.
