# Incident response runbook

*Fictional company. Written in English for the on-call team and international partners.*

## 1. Severity levels

| Severity | Definition | Example |
|---|---|---|
| SEV1 | Production down for several clients, or data breach suspected | Hosting cluster unreachable, leaked database |
| SEV2 | One client's service down or seriously degraded | E-commerce checkout failing for one shop |
| SEV3 | Minor degradation with a workaround | Slow back-office pages |

## 2. On-call rotation

One engineer from the Support & Infrastructure team is on call each week, from Monday 9 am to the following Monday 9 am. The on-call engineer must acknowledge a SEV1 page within **15 minutes**.

## 3. First steps for a SEV1

1. Acknowledge the page and open an incident channel named `#inc-YYYYMMDD-short-name`.
2. Appoint an incident commander; the commander coordinates and does not debug.
3. Post a first status update to affected clients within 30 minutes, then every hour.
4. Stabilise first (roll back, fail over, block traffic), investigate later.
5. If personal data may be exposed, alert the GDPR officer immediately: the 72-hour CNIL notification clock may have started.

## 4. Communication

Client-facing updates are written by the incident commander and say what is affected, what we are doing and when the next update will come. Never speculate about the cause in client communication.

## 5. Postmortem

Every SEV1 and SEV2 gets a blameless postmortem, published within **5 business days**. It contains a timeline, the root cause, what went well, what went badly, and action items with owners and due dates.
