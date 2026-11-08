> This page is a short version of the Software Requirements Specification. It lists only the core requirements. The full SRS, with every requirement, business rule and appendix, is kept in the repository as [docs/SRS.md](https://github.com/srwrrr/Apartment-Management/blob/main/docs/SRS.md). Requirement IDs (FR-xx, NFR-xx, BR-xx) are the same in both, so an ID used in the code or in another section of this report can always be looked up there.

# Software Requirements Specification — Apartment Management

| | |
|---|---|
| Course | CSE327 – Software Engineering |
| Prepared by | [Your Name / Team Members and IDs] |
| Submitted to | [Instructor Name] |
| Date | November 2026 |

---

## 1. Introduction

### 1.1 Purpose

This document describes what the Apartment Management system must do. The system is a web application for one apartment building. It keeps resident records, bills and payments, maintenance requests and announcements in one place, instead of paper records, phone calls and chat apps.

### 1.2 Scope

**In scope:** residents and units, monthly bills and payments, building expenses, maintenance requests, announcements and notifications, reports, and an English and Bangla interface.

**Out of scope:** online payment processing, SMS or email, visitor management, facility booking, native mobile apps, and more than one building.

### 1.3 Users

| User | What they do |
|---|---|
| Resident | Sees their bills and payments, submits maintenance requests, reads announcements. Mostly uses a phone. |
| Administrator | Manages residents, units, bills, payments, expenses, maintenance and announcements. |
| Staff | Does only what the administrator allows, for example updating the maintenance requests assigned to them. |

### 1.4 Constraints

- Web only; works in current Chrome, Firefox, Edge and Safari on phones and computers.
- Payments happen outside the system (cash, bank, bKash, Nagad) and are only recorded in it.
- All amounts are in Bangladeshi Taka (৳) and all times use Bangladesh time (UTC+6).

---

## 2. Key Business Rules

- **BR-02 — Passwords.** At least 8 characters with a letter and a digit. Five wrong logins in a row lock the account for 15 minutes.
- **BR-06 — Occupancy.** A resident is linked to a unit as owner or tenant with a start date. Each occupied unit has one billing contact.
- **BR-07 — One bill per unit per month.** Rent, utilities and other fees are charges on that one bill.
- **BR-09 — Bill status.** Calculated from the balance and due date: Paid, Partially paid, Unpaid or Overdue.
- **BR-11 — Payment amount.** More than ৳0 and no more than the bill's balance.
- **BR-13 — No deleting payments.** A wrong payment is voided with a reason and stays in the history.
- **BR-15 — Money format.** Amounts are stored exactly and shown with lakh grouping, e.g. ৳ 1,25,000.00.

---

## 3. Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Log in securely | Must |
| FR-02 | Role-based access | Must |
| FR-03 | Register and manage residents | Must |
| FR-05 | Assign residents to units | Must |
| FR-09 | Generate monthly bills | Must |
| FR-11 | Record payments | Must |
| FR-13 | Residents view bills and payments | Must |
| FR-15 | Collection and dues reports | Must |
| FR-16 | Submit and track maintenance requests | Must |
| FR-23 | Publish announcements | Must |
| FR-43 | Record building expenses | Should |
| FR-47 | Choose language (English / Bangla) | Should |

#### FR-01: Log in securely
Users log in with their phone number or email and a password.
- Wrong details show one general error message and do not say which part was wrong.
- The account locks after 5 wrong attempts (BR-02).
- Users can log out, and are logged out after 30 minutes of inactivity.

#### FR-02: Role-based access
Each user sees only the pages and data for their role.
- A resident cannot open admin pages, even by typing the address.
- A resident cannot see another resident's records by changing an ID.
- Staff can only use the permissions the administrator gave them.

#### FR-03: Register and manage residents
The administrator adds, edits, deactivates and reactivates residents.
- Adding a resident creates their login with a temporary password.
- Deactivating keeps the resident's history.
- Missing fields or a login ID already in use are shown next to the field.

#### FR-05: Assign residents to units
The administrator links a resident to a unit as owner or tenant.
- The unit shows Occupied or Vacant automatically.
- Overlapping stays and an end date before the start date are refused (BR-06).
- Past occupancy is kept.

#### FR-09: Generate monthly bills
The administrator creates a month's bills for all occupied units in one action.
- A preview shows how many bills and the total before confirming.
- Running it twice for the same month creates no duplicates (BR-07).
- If anything fails, no bills are saved.

#### FR-11: Record payments
The administrator or permitted staff record a payment with date, amount and method.
- The balance and status update (BR-09).
- Zero, negative or too-large amounts are refused (BR-11).
- A receipt PDF becomes available.

#### FR-13: Residents view bills and payments
- The resident's home page shows what they owe.
- Each bill shows its charges, amount paid, balance, due date and status.
- Residents never see another unit's bills.

#### FR-15: Collection and dues reports
- For a chosen period: total billed, collected and outstanding.
- A list of units with unpaid dues.
- Reports can be printed or exported as CSV, and match the records exactly.

#### FR-16: Submit and track maintenance requests
A resident reports a problem with a category, description and up to 3 photos.
- The request moves through Submitted, Under review, In progress, Resolved and Closed.
- The administrator sets the priority and assigns it to staff.
- The resident is notified when the status changes.

#### FR-23: Publish announcements
The administrator publishes notices to all residents or a chosen group.
- Important notices are pinned at the top.
- Residents get an in-app notification.
- A notice can be printed as an A4 PDF.

#### FR-43: Record building expenses
The administrator records what the building spends (date, category, amount, payee).
- Expenses can be filtered by month and category.
- A wrong expense is voided with a reason, never deleted.

#### FR-47: Choose language
- Users switch between English and Bangla on the login page and in the menu.
- The choice is saved to their account.
- Bangla displays correctly on screen and in PDFs.

---

## 4. Non-Functional Requirements

| ID | Area | Requirement | How it is checked |
|---|---|---|---|
| NFR-02 | Security | Every server endpoint checks the user's role and permissions; hiding a button is not enough. | Automated tests call each endpoint as each role. |
| NFR-10 | Usability | Every page works from a 360 px phone screen to a desktop, with no sideways scrolling. | Browser tests on desktop and phone sizes. |
| NFR-12 | Accessibility | Basic WCAG 2.1 AA: enough contrast, keyboard use, labelled fields. | Lighthouse accessibility score of at least 90. |
| NFR-14 | Reliability | Changes to several records (bills, payments) are all-or-nothing. | Tests that force a failure part-way. |
| NFR-17 | Performance | Common actions respond within 2 seconds for 20 users at once. | Load test. |
| NFR-22 | Maintainability | Business rules have automated tests; backend coverage at least 60%. | Coverage report. |
