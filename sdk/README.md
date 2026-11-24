# @openmeet/sdk

Dependency-free TypeScript client for the OpenMeet REST API (Node ≥ 18, Deno, Bun, browsers, Workers).

```ts
import { OpenMeet, verifyWebhookSignature } from "@openmeet/sdk";

const om = new OpenMeet({ baseUrl: "https://meet.example.com", apiKey: process.env.OPENMEET_API_KEY! });

const { data: types } = await om.eventTypes();
const { data: avail } = await om.availability({ eventTypeId: types[0].id });
const { data: booking } = await om.createBooking(
  { eventTypeId: types[0].id, start: avail.slots[0].startMs, name: "Ada", email: "ada@example.com", timezone: "Europe/Berlin" },
  { idempotencyKey: "crm-4711" },
);

// AI agents (service token with the "agent" scope)
const today = await om.agent.agenda();

// Incoming webhooks
const ok = await verifyWebhookSignature(secret, rawBody, request.headers.get("x-openmeet-signature")!);
```

The package ships TypeScript sources (`index.ts`); bundle it with your app or copy the file. See `docs/api.md` for endpoints and scopes.
