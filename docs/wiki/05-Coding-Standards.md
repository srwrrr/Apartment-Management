# 5. Coding Standards and Guidelines

These are the rules the team followed. Where a tool can check a rule, it does: the **TypeScript compiler** (strict mode) and **ESLint** (`npm run lint`, which also runs in GitHub Actions on every push) reject code that breaks them. The other rules were checked in code review. Every example below is taken from the project's code.

## Summary

| # | Rule | Enforced by |
|---|---|---|
| 1 | TypeScript everywhere, in strict mode | TypeScript compiler |
| 2 | Naming conventions for files, components, functions and constants | Code review |
| 3 | Consistent formatting | Code review, editor settings |
| 4 | Money is always whole poisha (integers) | `poishaSchema`, types, tests |
| 5 | Every input is validated with a shared Zod schema | Code review, tests |
| 6 | Errors carry a machine code; the client turns it into words | `ApiError`, `errorMessage()` |
| 7 | No user-visible text in code: every word goes through translations | Code review, locale test |
| 8 | Multi-record changes run in one transaction | Code review, tests |
| 9 | Dates mean "today in Dhaka" | `lib/dates.ts` helpers |
| 10 | Safe JavaScript: `===`, no forgotten promises, no unsafe `any` | ESLint |
| 11 | Every form field has a label; every control is reachable by keyboard | `Field` component, axe tests |
| 12 | Comments explain *why*, and name the requirement | Code review, TypeDoc |
| 13 | Tests are named after the requirement they prove | Code review |
| 14 | Small, focused commits with a clear message | Code review |

## Rule 1: TypeScript everywhere, in strict mode

All code (web, server, shared) is TypeScript with `strict` on, plus `noUncheckedIndexedAccess`, which makes array and object lookups possibly `undefined` so they must be checked.

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "target": "ES2022",
    "module": "ESNext"
  }
}
```

**Why:** many bugs (a missing field, a `null` that was not checked, a typo in a property name) are caught before the code runs.

## Rule 2: Naming conventions

| Kind | Convention | Examples from the code |
|---|---|---|
| React components and their files | `PascalCase`, pages end in `Page` | `BillDetailPage.tsx`, `MonthInput.tsx`, `function BalanceCard()` |
| Server files | `feature.role.ts` | `billing.routes.ts`, `bills.service.ts`, `payments.service.ts` |
| Functions and variables | `camelCase`, starting with a verb for actions | `generateBills`, `recordPayment`, `lockBill`, `todayDhaka` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_POISHA`, `SESSION_MINUTES`, `RECURRING_CHARGE_TYPES` |
| Types and interfaces | `PascalCase` | `PlannedBill`, `SkippedUnit`, `AuthUser` |
| Error codes and translation keys | `UPPER_SNAKE` codes, dotted keys | `AMOUNT_EXCEEDS_BALANCE`, `billing.youOwe` |
| Deliberately unused names | leading underscore | `(_req, res) => ...` |

```ts
export const MAX_POISHA = 1_000_000_000;
export const SESSION_MINUTES = 30; // NFR-03: end sessions after inactivity
export async function generateBills(input: GenerateBillsInput, actor: Actor, dryRun: boolean) { /* ... */ }
```

## Rule 3: Consistent formatting

Two-space indentation, single quotes, semicolons, trailing commas in multi-line lists, and one component or service area per file. Long expressions are split over several lines with one item per line.

```ts
const DEMO_ACCOUNTS = [
  { role: 'ADMIN', loginId: 'admin@demo.local', password: 'Admin1234' },
  { role: 'STAFF', loginId: 'manager@demo.local', password: 'Manager1234' },
  { role: 'RESIDENT', loginId: 'resident@demo.local', password: 'Resident1234' },
];
```

## Rule 4: Money is always whole poisha

Amounts are stored, sent and calculated as integers in poisha (1 taka = 100 poisha). They become text only at the very end, through `formatBDT`, and typed amounts become poisha only through `parseTaka`.

```ts
// Shared validation: an amount must be a positive whole number of poisha.
export const poishaSchema = z.number().int().positive().max(MAX_POISHA);

formatBDT(12500000); // "৳ 1,25,000.00"  (lakh grouping)
parseTaka('12,500.5'); // 1250050
```

**Why:** `0.1 + 0.2 !== 0.3` in floating point. With integers, a balance is always exact (BR-15).

## Rule 5: Validate every input with a shared Zod schema

Routes never trust the request body. They parse it with a schema from `packages/shared`, and the web form uses the same schema, so the rules cannot differ.

```ts
billsRouter.post(
  '/:id/payments',
  requirePermission('payments.record'),
  asyncHandler(async (req, res) =>
    res.status(201).json(await recordPayment(param(req.params.id), paymentInputSchema.parse(req.body), req.user!))),
);
```

## Rule 6: Errors carry a machine code; the client turns it into words

The server throws `ApiError` with an HTTP status and a code, never a sentence. `asyncHandler` passes any error to one error handler, which sends one standard JSON shape. The web app looks the code up in the user's language.

```ts
// Server
export class ApiError extends Error {
  constructor(public status: number, public code: string, public fields?: Record<string, { code: string; params?: Record<string, unknown> }>) {
    super(code);
  }
}
throw new ApiError(400, 'VALIDATION_FAILED', { amount: { code: 'AMOUNT_EXCEEDS_BALANCE', params: { balance: s.balance } } });

// Web
export function errorMessage(t: TFunction, error: unknown): string {
  const code = error instanceof ApiError ? error.code : 'INTERNAL';
  return t(`errors.${code}`, { defaultValue: t('errors.INTERNAL') });
}
```

**Why:** the same error is shown correctly in English and Bangla, and users never see technical codes (NFR-11).

## Rule 7: No user-visible text in code

Every word on screen is a translation key, with an entry in both `en.json` and `bn.json`. A test checks that both files have exactly the same keys.

```tsx
<p className="text-muted">{t('billing.youOwe')}</p>
<Chip tone="red">{t('billing.overdueCount', { count: q.data.overdueBills })}</Chip>
```

```json
// en.json                          // bn.json
"youOwe": "You owe",                "youOwe": "আপনার বাকি",
"overdueCount": "{{count}} overdue" "overdueCount": "{{count}}টি মেয়াদ উত্তীর্ণ"
```

## Rule 8: Changes to several records run in one transaction

If an operation writes more than one row (a payment, its notification and its activity-log entry), it uses `prisma.$transaction`. Either everything is saved or nothing is.

```ts
export async function recordPayment(billId: string, input: PaymentInput, actor: Actor) {
  const paymentId = await prisma.$transaction((tx) => recordPaymentIn(tx, billId, input, actor));
  return { paymentId, bill: await getBill(billId) };
}
```

## Rule 9: "Today" means today in Dhaka

The server may run in any time zone (Render's servers use UTC). Code never calls `new Date()` to decide what day it is. It uses the helpers in `lib/dates.ts`.

```ts
// "Today" always means today in Asia/Dhaka (UTC+6), not the server's local time.
const dhaka = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' });
export const todayDhaka = (): string => dhaka.format(new Date());
```

## Rule 10: Safe JavaScript, enforced by ESLint

The ESLint configuration (`eslint.config.mjs`) uses ESLint's recommended rules, typescript-eslint's type-aware rules and React's hooks rules. Examples of what it enforces:

| Rule | Bad | Good |
|---|---|---|
| `eqeqeq` | `if (a == b)` | `if (a === b)`; the one allowed exception is `x != null`, which deliberately means "not null and not undefined" |
| `no-floating-promises` | `i18n.init({ ... })` (a promise nobody waits for) | `void i18n.init({ ... })` with a comment saying why nothing waits |
| `no-unsafe-member-access` | `err.code` on an `any` value | name the fields first: `const known = err as { code?: unknown }` |
| `no-unused-vars` | an unused import or variable | remove it, or prefix `_` if it is deliberately unused |
| `react-hooks/rules-of-hooks` | a hook inside an `if` | hooks only at the top level of a component |

The findings ESLint made and how each was fixed are on the [Code Review page](09-Code-Review).

## Rule 11: Accessible by default

Every form field is wrapped in the shared `Field` component, which connects the label, the error message and the help text to the input. Every control is a real `<button>`, `<a>` or `<input>`, so it works with a keyboard and screen readers.

```tsx
<Field label={t('expenses.date')} error={fields.spentOn}>
  {(p) => <TextInput {...p} type="date" required max={todayYmd()} value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />}
</Field>
```

## Rule 12: Comments explain why, and name the requirement

Comments do not repeat what the code says. They explain the reason, and link the code to the requirement (FR-xx, BR-xx or NFR-xx) it implements. Exported functions get TSDoc comments (see the [documentation page](06-Source-Code-Documentation)).

```ts
// BR-05: unavailable units are never billed
where: { isAvailable: true, occupancies: { some: overlap } },

// Someone else generated the same month a moment ago. Nothing was saved; check the preview again.
if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError(409, 'BILLS_ALREADY_EXIST');
```

## Rule 13: Tests are named after the requirement they prove

Test names read as sentences and start with the requirement or business rule ID, so a failing test points straight to the rule that broke.

```ts
describe('FR-11 record payments', () => {
  it('BR-11: refuses more than the balance and says what the balance is; paying exactly the balance is fine', async () => { /* ... */ });
  it('NFR-14 / BR-11: two people paying the full balance at the same moment cannot overpay', async () => { /* ... */ });
});
```

## Rule 14: Clear, focused commits

Each commit does one thing. The first line is a short summary in the imperative ("Add", "Fix", "Rewrite"), followed by a blank line and a body explaining what changed and why.

```
Resident home: replace the outdated 'coming soon' line

Bills and maintenance requests exist now; the intro describes what the
page shows instead, in English and Bangla.
```
