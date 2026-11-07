# Diagrams

These are written in Mermaid, so GitHub draws them and they stay easy to change. They show the system as built.

## Use cases

Mermaid has no use-case diagram, so this one uses a flowchart: people on the left, what they can do on the right. Household members can do what a resident does, except that they are never the billing contact.

```mermaid
flowchart LR
  R([Resident])
  S([Staff member])
  A([Administrator])
  T([System jobs])

  subgraph Money
    UC1(View bills and statements)
    UC2(Report a payment)
    UC3(Record or verify a payment)
    UC4(Generate monthly bills)
    UC5(Record expenses)
    UC6(Issue a no-dues certificate)
  end
  subgraph Maintenance
    UC7(Submit a request with photos)
    UC8(Confirm and rate a fix)
    UC9(Work on assigned tasks)
    UC10(Prioritise and assign)
    UC11(Set up scheduled jobs)
  end
  subgraph Communication
    UC12(Read announcements and notifications)
    UC13(Open emergency contacts)
    UC14(Publish, target and schedule announcements)
    UC15(Print a notice)
  end
  subgraph Administration
    UC16(Manage units, residents and household members)
    UC17(Manage staff permissions)
    UC18(Run the move-out wizard)
    UC19(View dashboard and reports)
    UC20(Read the activity log)
  end

  R --> UC1 & UC2 & UC7 & UC8 & UC12 & UC13
  S --> UC9 & UC12 & UC13
  S -. with permission .-> UC3 & UC4 & UC5 & UC10 & UC11 & UC14 & UC15 & UC16 & UC19
  A --> UC3 & UC4 & UC5 & UC6 & UC10 & UC11 & UC14 & UC15 & UC16 & UC17 & UC18 & UC19 & UC20
  T --> UC11 & UC14
```

## Classes

The main entities. Bill status, balances and who may see what are worked out from these rather than stored.

```mermaid
classDiagram
  class User {
    loginId
    fullName
    role
    language
    isActive
  }
  class Unit {
    unitNumber
    floor
    isAvailable
  }
  class Occupancy {
    type
    startDate
    endDate
    isBillingContact
  }
  class HouseholdMember {
    relation
    addedAt
    removedAt
  }
  class Bill {
    kind
    billingMonth
    dueDate
  }
  class Charge {
    type
    amount
  }
  class Payment {
    amount
    paidOn
    method
    receiptNo
    voidedAt
  }
  class PaymentReport {
    amount
    reference
    status
  }
  class MaintenanceRequest {
    number
    category
    priority
    status
    dueAt
  }
  class RequestUpdate {
    kind
    note
    isInternal
  }
  class RequestRating {
    stars
    comment
  }
  class ScheduledTask {
    title
    intervalMonths
    nextDueDate
    isPaused
  }
  class Announcement {
    title
    audienceType
    publishedAt
    endsAt
  }
  class ResidentGroup {
    name
  }
  class Notification {
    type
    params
    readAt
  }
  class ActivityLog {
    action
    details
    createdAt
  }

  User "1" --> "*" Occupancy : lives as
  Unit "1" --> "*" Occupancy
  Occupancy "1" --> "*" HouseholdMember
  User "1" --> "*" HouseholdMember : is
  Unit "1" --> "*" Bill
  Bill "1" *-- "1..*" Charge
  Bill "1" --> "*" Payment
  Bill "1" --> "*" PaymentReport
  PaymentReport "0..1" --> "0..1" Payment : becomes
  User "0..1" --> "*" MaintenanceRequest : submits
  Unit "0..1" --> "*" MaintenanceRequest
  MaintenanceRequest "1" *-- "*" RequestUpdate
  MaintenanceRequest "1" --> "0..1" RequestRating
  ScheduledTask "0..1" --> "*" MaintenanceRequest : creates
  Announcement "*" --> "*" User : sent to
  ResidentGroup "*" --> "*" User : has members
  User "1" --> "*" Notification
  User "0..1" --> "*" ActivityLog : did
```

## Sequence: a resident's payment is verified

This is the path where mistakes cost the most. One transaction covers everything from the lock onwards, so a failure leaves nothing half done.

```mermaid
sequenceDiagram
  actor Res as Resident
  actor Desk as Office
  participant Web as Web app
  participant API as API
  participant DB as PostgreSQL

  Res->>Web: Report payment (amount, bKash ID, screenshot)
  Web->>API: POST /api/bills/:id/payment-reports
  API->>DB: Can this person see this bill?
  API->>DB: Save the report (Pending), notify the office
  API-->>Web: Report saved
  Desk->>Web: Open payment reports, press Verify
  Web->>API: POST /api/payment-reports/:id/verify
  API->>DB: Begin, lock the bill
  API->>DB: Check the balance and the reference
  API->>DB: Next receipt number from the yearly counter
  API->>DB: Save payment, mark report Verified
  API->>DB: Notify the household, write the activity log
  API->>DB: Commit
  API-->>Web: Verified, new balance
  Res->>Web: Download receipt
  Web->>API: GET /api/payments/:id/receipt.pdf
  API->>DB: Can this person see this bill?
  API-->>Res: PDF in their language
```

## Sequence: a scheduled job becomes a request

```mermaid
sequenceDiagram
  participant Job as Background job
  participant DB as PostgreSQL
  actor Staff as Assigned staff

  Job->>DB: Tasks due within 7 days and not paused
  loop each task
    Job->>DB: Begin, lock the task (skip if locked)
    Job->>DB: Create request: common area, Medium, Under review
    Job->>DB: Deadline is the due date
    Job->>DB: Notify the assignee
    Job->>DB: Move the next due date forward
    Job->>DB: Commit
  end
  DB-->>Staff: Appears in My tasks
```

## State: a maintenance request

```mermaid
stateDiagram-v2
  [*] --> Submitted : resident reports
  [*] --> UnderReview : scheduled job
  Submitted --> UnderReview : prioritised or assigned
  Submitted --> Cancelled : resident cancels
  Submitted --> Rejected : reviewer, with reason
  UnderReview --> Rejected : reviewer, with reason
  UnderReview --> InProgress : work starts
  InProgress --> Resolved : with a note
  Resolved --> Closed : resident confirms, or after 7 days
  Resolved --> InProgress : resident says not fixed
  Closed --> [*]
  Cancelled --> [*]
  Rejected --> [*]
```

## State: a payment report

```mermaid
stateDiagram-v2
  [*] --> Pending : resident reports
  Pending --> Verified : office confirms, payment recorded
  Pending --> Rejected : office rejects, with reason
  Verified --> [*]
  Rejected --> [*]
```

## Deployment

```mermaid
flowchart LR
  P[Phone or computer browser] -- HTTP --> N[Node server, port 4000]
  N --> W[Built web app]
  N --> A[API and background jobs]
  A --> D[(PostgreSQL)]
  A --> F[Uploads folder]
  A --> C[Headless Chromium for PDFs]
  B[Backup script] --> D
  B --> F
```
