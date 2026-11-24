# Integration setup

All credentials are entered in **Administration → Integrations** (or in the setup wizard) and stored AES-GCM encrypted in D1. Redirect URIs are shown there, based on the configured public URL:

```
https://<public-url>/auth/oauth/google/callback
https://<public-url>/auth/oauth/microsoft/callback
https://<public-url>/auth/oauth/zoom/callback
```

## Google

Used for "Sign in with Google", Google Calendar (free/busy + events) and Google Meet links.

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. *APIs & Services → Library* → enable **Google Calendar API**.
3. *OAuth consent screen*: External (or Internal for Workspace). Add scopes:
   `openid`, `email`, `profile`, `…/auth/calendar.calendarlist.readonly`, `…/auth/calendar.freebusy`, `…/auth/calendar.events`.
   While in "Testing" mode only listed test users can connect; publish the app for general use (Google may require verification for calendar scopes).
4. *Credentials → Create credentials → OAuth client ID → Web application*. Authorized redirect URI: the Google URI above.
5. Paste client ID and secret into OpenMeet.

Users then connect under **Integrations → Google Calendar → Connect**, choose which calendars are checked for conflicts and which one receives new bookings. Google Meet links are created when an event type uses the location "Google Meet" and the host's target calendar is a Google calendar.

## Microsoft

Used for "Sign in with Microsoft", Outlook/Microsoft 365 calendars and Teams meetings.

1. [Microsoft Entra admin center](https://entra.microsoft.com/) → *App registrations → New registration*.
2. Supported account types: as needed (multi-tenant + personal accounts → tenant `common`; single tenant → your tenant ID).
3. Redirect URI (Web): the Microsoft URI above.
4. *Certificates & secrets* → new client secret.
5. *API permissions* → Microsoft Graph delegated: `openid`, `email`, `profile`, `offline_access`, `User.Read`, `Calendars.ReadWrite`.
6. Enter client ID, secret and tenant in OpenMeet.

Teams links are created when the location is "Microsoft Teams" and the host's target calendar is a Microsoft calendar (work/school accounts with Teams).

> Status: implemented, not verified against a live tenant in this release.

## Zoom

1. [Zoom App Marketplace](https://marketplace.zoom.us/) → *Develop → Build App → General App (OAuth)*.
2. Redirect URL + allow list: the Zoom URI above.
3. Scopes: `meeting:write:meeting`, `user:read:user`.
4. Enter client ID/secret in OpenMeet; users connect Zoom under Integrations.

> Status: implemented, not verified against a live account in this release.

## CalDAV

Users enter the URL of one calendar collection plus username and an **app-specific password**, e.g. Fastmail `https://caldav.fastmail.com/dav/calendars/user/<you>/Default/`, Nextcloud `https://cloud.example.com/remote.php/dav/calendars/<user>/personal/`. iCloud requires discovering the collection URL first (principal lookup is not automated).

## ICS feeds

Any calendar's secret iCal address (https or webcal) can be added as a read-only conflict source. Recurring events: only the first occurrence is considered (RRULE expansion is not implemented yet). Tip: subscribe to a public-holiday ICS feed to block holidays automatically.

## E-mail

| Provider | What you need |
| --- | --- |
| [Resend](https://resend.com) | API key, verified sending domain |
| [Brevo](https://www.brevo.com) | API v3 key, verified sender |
| [Postmark](https://postmarkapp.com) | Server API token, verified sender signature |

After saving, use **Send test e-mail** and check **Administration → E-mail log**. Without a provider, OpenMeet still works: e-mails are logged as "skipped" and the UI says so.

Templates: built-in templates (English/German, chosen by the recipient's language) for confirmations, requests, organizer notifications, cancellations, reschedules, declines, reminders (24 h and 1 h) and no-show follow-ups, all with ICS attachments where useful. Custom messages: create a workflow with a "Send e-mail" step (variables like `{{attendee.name}}`, `{{booking.time}}`, `{{booking.cancel_url}}`).
