# Vendor Document Upload

## Objective
Upload a document from Google Drive to a Vanta vendor or vendor security review.

## Inputs
- Client
- Vendor (from dashboard)
- Document title, type, Drive file ID (or pick from Vendor Doc Library)

## Steps
1. Select client and click **Load Vendors**. Filter by risk if needed.
2. Click **Upload Doc** on a vendor row. In the drawer, enter document title and Drive file ID (or use doc library).
3. Submit. Server uploads via Vanta API; audit log records the action.

## Edge cases
- Document title and Drive file ID required. Use Vendor Doc Library for pre-defined mappings.
- Auto-upload: use for Critical/High vendors with overdue reviews; matches library by vendor + type.
