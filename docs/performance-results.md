# Performance results

Measured on 7 November 2026 on a development laptop, with the API, the database and the test client on the same machine. Run it again with `npm run perf` in the `server` folder. It uses its own `apartment_perf` database and does not touch your data.

The data was 500 units, 2,000 residents, 3,000 bills with 2,400 payments, and 2,000 maintenance requests. That is well above the demo size in SRS §2.7 (100 units, 300 users).

| Requirement | Target | Measured |
|---|---|---|
| NFR-19: generate bills for 500 units | 10 s | 0.4 s |
| NFR-18: search and filters, slowest of 10 at the 95th percentile | 1 s | 84 ms |
| PDF receipt, 95th percentile | 3 s | 331 ms |
| NFR-17: 20 people working at once, 95th percentile | 2 s | 219 ms and 376 ms in two runs |

In the 20-person test, 10 office users opened pages and recorded payments while 10 residents checked their bills, for 20 seconds. The first run made 3,953 requests with no server errors, and the slowest single request took about 1.1 s.

Because everything ran on one machine, these figures leave out network time. A resident's phone on mobile data will feel slower than this.
