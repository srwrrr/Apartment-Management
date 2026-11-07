# Backup and restore

Covers NFR-15 (daily backups, last 7 kept) and NFR-16 (a tested restore).

## Make a backup

From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/backup.ps1
```

This writes `backups/apartment-YYYY-MM-DD.dump` and copies the uploaded photos and receipts to `backups/uploads-YYYY-MM-DD`. Copies older than 7 days are removed, but only after a new backup has succeeded. The `backups/` folder is not committed to git.

## Run it every day

The backup does not schedule itself. Set this up once on the computer that runs the system, changing the path to yours:

```powershell
schtasks /Create /SC DAILY /ST 02:00 /TN "Apartment backup" /TR "powershell -ExecutionPolicy Bypass -File C:\path\to\Apartment-Management\scripts\backup.ps1"
```

The computer has to be on at that time. Copy the `backups/` folder to another disk now and then: a backup on the same disk does not survive that disk failing.

## Restore a backup

```powershell
powershell -ExecutionPolicy Bypass -File scripts/restore.ps1 backups/apartment-2026-11-07.dump -Target apartment_restored
```

The script always restores into a new database and refuses a name that already exists, so it cannot overwrite live data. To switch to the restored copy:

1. Stop the server.
2. Set `DATABASE_URL` in `.env` to the new database.
3. Copy the matching `uploads-YYYY-MM-DD` folder to the `UPLOAD_DIR` location.
4. Start the server.

## Restore test

Run on 7 November 2026, against the load-test data, using the two scripts above.

| Check | Result |
|---|---|
| Backup file size | 1,034 KB |
| Restore time | 3.5 s |
| Tables compared | 25 of 25 identical |
| Rows compared | 17,449 |
| Valid payments total, original and restored | 720,016,400 poisha in both |
| Balance across all bills, read through the `bill_summary` view | 354,983,600 poisha in both |
| Activity log still refuses deletion after restore | Yes |
| Restoring over an existing database | Refused |

The uploads copy was not part of this test, because the load-test data has no uploaded files. Repeat the test with real photos before the final demo.
