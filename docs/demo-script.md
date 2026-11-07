# Demo script

About 10 minutes. It follows one story: a resident has a problem and a payment to report, and the office deals with both.

## Before you start

1. Run `npm run demo:reset`. This deletes everything in the database, so only use it on the demo database. Do it on the day: the demo data is dated from today.
2. Run `npm run app` and open <http://localhost:4000>.
3. Open a second browser window for the resident. Use a private window, or a different browser, so the two logins stay separate. Set it to phone size with the browser's device toolbar.
4. Log in to neither yet. The login page shows the demo buttons.

Keep `docs/SRS.md` open in case someone asks about a requirement.

## 1. The resident (3 minutes, phone window)

Press **Resident**. This is Nusrat Jahan in flat 3B.

1. **Home:** point out the balance and the latest announcement. Say that a resident sees only their own records.
2. **Bangla and large text:** open **Menu**, choose **বাংলা**, then **A+**. Everything changes, and the page still fits the phone. Switch back to English.
3. **Report a payment:** open **Bills**, open the October bill, which is part-paid, and report the rest by bKash with any transaction ID.
4. **Finish a repair:** open **My requests**, then *Kitchen tap is leaking*. Press **Yes, it is fixed**, give it 5 stars, and send the rating.
5. **Emergency contacts:** open it from the menu. Say that on a phone a number starts a call, and the numbers still open without internet.

## 2. The office (5 minutes, desktop window)

Press **Administrator**.

1. **Dashboard:** show the collection rate falling from 98% to 50%, and press **Show as table** to show the same numbers for screen readers. Show the three reports waiting, and the latest activity.
2. **Check the payment:** open **Payment reports**. Nusrat Jahan's report is there. Verify it. Open the bill and download the receipt.
3. **Rating:** open **Requests**, then *Kitchen tap is leaking*, to show the rating arrived.
4. **Scheduled job:** open **Scheduled jobs**. The lift service repeats monthly, and the system has already created its next request 7 days early. Show it in **Requests**, marked as a scheduled job.
5. **Announcement:** open **Announcements**. *New rules for visitor parking* is scheduled: nobody can see it until tomorrow. Open *Water off on Saturday* and press **Print notice** for the lift lobby.
6. **Committee report:** open **Reports**, scroll to **Monthly committee report**, choose last month and download the PDF. Then export the dues list to CSV.
7. **Activity log:** open it to show that everything you just did is recorded, and say that the database refuses changes to it.

## 3. Security (1 minute)

In the resident window, copy the address of one of the resident's bills. Change a few characters of the ID and press Enter. It says the record was not found. It does the same for someone else's real bill, so a resident can't even tell whether it exists.

## 4. If there is time

- **Move-out wizard:** open **Units**, choose a unit, then **Move out**. It checks dues, moves the billing contact, can issue a certificate, and closes the accounts.
- **Household member:** log in as `family@demo.local` to show a family member's own login. Then remove them from flat 3B and show they can no longer log in.
- **Install:** in Chrome, use **Install app** on the address bar.

## If something goes wrong

| Problem | What to do |
|---|---|
| The page will not load | Check that `npm run app` is still running, and run it again |
| A PDF fails | Say so and move on; everything else still works. Restart the app afterwards |
| The data looks wrong after rehearsing | `npm run demo:reset`, then log in again |
| "Too many attempts" at login | Restart the app, then use the demo buttons |
| No internet | Nothing needed: the demo runs entirely on the laptop |

## Likely questions

**Why no online payments?** They are out of scope for version 1. Residents pay by bKash or Nagad as they do now, and report it. The office checks it, and only then does the money count.

**How do you stop two people paying the same bill twice?** The bill row is locked during a payment, and the database also rejects overpayment.

**What is not finished?** The usability test with real people has not been run. See `docs/usability-test.md`.
