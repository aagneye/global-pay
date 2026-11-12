# openapi

`openapi.json` is the GlobalPay HTTP API, generated from the backend's route schemas (`services/api`). Don't edit it by hand.

- **Regenerate it** after changing a route: `cd services/api && npm run openapi`. The backend's tests fail while it's out of date.
- **Consumers:** the Flutter app generates its typed client from it (`apps/mobile`, see `swagger_parser.yaml`).

A running backend serves the same spec at `/docs/json`, with a browsable version at `/docs`.
