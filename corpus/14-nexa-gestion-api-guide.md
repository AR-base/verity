# Nexa Gestion API guide

*Fictional company. Technical reference for clients who use Nexa Gestion in white label.*

## 1. Authentication

Every request carries an API key in the `X-Nexa-Key` header. Keys are created in the administration area and must be rotated every **90 days**; expired keys are rejected. Never put an API key in front-end code.

## 2. Rate limits

Each key may send up to **100 requests per minute**. Beyond that, the API answers with error NX-429 and a `Retry-After` header.

## 3. Pagination

List endpoints return 50 items per page by default (maximum 200), with a `next_cursor` field to fetch the next page.

## 4. Error codes

| Code | Meaning | What to do |
|---|---|---|
| NX-400 | Invalid request body | Check required fields and types |
| NX-401 | Missing or invalid API key | Send a valid key in `X-Nexa-Key` |
| NX-403 | Key valid but not allowed for this resource | Ask an administrator to extend the key's scope |
| NX-409 | Conflict: the invoice number already exists | Let the server generate invoice numbers |
| NX-429 | Rate limit exceeded | Wait for the `Retry-After` delay |
| NX-503 | Maintenance window in progress | Retry after the window; windows are announced 48 hours ahead |

## 5. Webhooks

Nexa Gestion can call your URL when an invoice is paid or a ticket changes status. Each call is signed with HMAC-SHA256 in the `X-Nexa-Signature` header; reject any call whose signature does not match. Failed deliveries are retried 5 times over 24 hours.
