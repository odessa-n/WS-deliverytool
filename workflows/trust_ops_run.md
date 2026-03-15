# Trust Ops Run

## Objective
Pull outstanding Vanta tests and documents for a client into a formatted client-ready update.

## Inputs
- Client (from dropdown)
- Optional: Project plan link, evidence drop link, ops lead, frameworks (prefilled from Client Management)
- Framework selection: multi-select or use saved frameworks for scoping

## Steps
1. Select client. Metadata and frameworks prefill if set in Client Management.
2. Optionally select frameworks for scoping (or use saved frameworks).
3. Click **Generate from Vanta**. Server fetches outstanding tests and documents, builds structured + formatted output.
4. Copy formatted message or use structured table as needed.

## Edge cases
- No frameworks set: warning shown; add in Client Management for correct scoping.
- Invalid URLs for plan/evidence links: validation blocks save; fix before generating.
- Token or Vanta errors: toast shows error; check client token and retry.
