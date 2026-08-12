# Venus Chicken Centers — Test Report

**Run:** 2026-08-12  
**Database:** throwaway SQLite file, deleted after the run  
**Result:** 448/448 passed, 0 failed

## Summary by module

| Module | Cases | Passed | Failed |
|---|---:|---:|---:|
| Activity log | 16 | 16 | 0 |
| Advances | 10 | 10 | 0 |
| Approval | 14 | 14 | 0 |
| Attendance | 7 | 7 | 0 |
| Authentication | 10 | 10 | 0 |
| Auto-closing stock | 6 | 6 | 0 |
| Balance correction | 5 | 5 | 0 |
| Branches | 8 | 8 | 0 |
| Calc engine | 23 | 23 | 0 |
| Carry-forward | 8 | 8 | 0 |
| Cash history | 2 | 2 | 0 |
| Cash tally | 20 | 20 | 0 |
| Daily entry | 17 | 17 | 0 |
| Date permission | 12 | 12 | 0 |
| Day-close lock | 4 | 4 | 0 |
| Duplicates | 12 | 12 | 0 |
| Functions | 4 | 4 | 0 |
| Hotel RBAC | 6 | 6 | 0 |
| Hotel ledger | 7 | 7 | 0 |
| Hotel pricing | 10 | 10 | 0 |
| Hotel receipts | 7 | 7 | 0 |
| Hotel sales | 14 | 14 | 0 |
| Hotels | 21 | 21 | 0 |
| Infrastructure | 4 | 4 | 0 |
| Labour | 5 | 5 | 0 |
| Ledger edit | 4 | 4 | 0 |
| Live pricing | 3 | 3 | 0 |
| Live sales | 10 | 10 | 0 |
| Manual closing stock | 7 | 7 | 0 |
| Meat reconciliation | 9 | 9 | 0 |
| Opening lock | 10 | 10 | 0 |
| Overhead edit | 7 | 7 | 0 |
| Overhead ledger | 10 | 10 | 0 |
| Overhead visibility | 2 | 2 | 0 |
| Overheads | 16 | 16 | 0 |
| Paging | 7 | 7 | 0 |
| Payroll | 10 | 10 | 0 |
| Photos | 12 | 12 | 0 |
| RBAC | 13 | 13 | 0 |
| Robustness | 9 | 9 | 0 |
| Scale | 2 | 2 | 0 |
| Schema | 15 | 15 | 0 |
| Session | 4 | 4 | 0 |
| Settings | 3 | 3 | 0 |
| Today-only | 15 | 15 | 0 |
| Users | 9 | 9 | 0 |
| Validation | 12 | 12 | 0 |
| Wage override | 2 | 2 | 0 |
| Window | 4 | 4 | 0 |
| Workers rename | 1 | 1 | 0 |
| **Total** | **448** | **448** | **0** |

## Test cases

| # | Module | Scenario | Input / condition | Expected | Actual | Result |
|---|---|---|---|---|---|---|
| TC-001 | Infrastructure | Health endpoint reports the database | GET /healthz | ok | ok | PASS |
| TC-002 | Infrastructure | All tables created | db.create_all() | 15 | 15 | PASS |
| TC-003 | Infrastructure | SPA shell is served | GET / | True | as expected | PASS |
| TC-004 | Infrastructure | Unknown API path returns JSON not HTML | GET /api/nope | not_found | not_found | PASS |
| TC-005 | Authentication | Valid admin credentials | admin/admin123 | 200 | 200 | PASS |
| TC-006 | Authentication | Wrong password rejected | admin/badpass | 401 | 401 | PASS |
| TC-007 | Authentication | Unknown username rejected | ghost/x | 401 | 401 | PASS |
| TC-008 | Authentication | Empty credentials rejected | '' / '' | 401 | 401 | PASS |
| TC-009 | Authentication | Username is case-insensitive | ADMIN/admin123 | 200 | 200 | PASS |
| TC-010 | Authentication | Password is case-sensitive | admin/ADMIN123 | 401 | 401 | PASS |
| TC-011 | Authentication | Passwords stored hashed, never plaintext | inspect users table | True | as expected | PASS |
| TC-012 | Authentication | SQL injection in username is harmless | ' OR 1=1 -- | 401 | 401 | PASS |
| TC-013 | Authentication | Anonymous cannot read data | GET /api/bootstrap | 401 | 401 | PASS |
| TC-014 | Authentication | Logout ends the session | POST /api/logout then /api/me | None | None | PASS |
| TC-015 | Session | Admin idle limit is 2 minutes | login as admin | 2 | 2 | PASS |
| TC-016 | Session | Supervisor idle limit is 10 minutes | login as ravi | 10 | 10 | PASS |
| TC-017 | Session | Heartbeat keeps the session alive | POST /api/heartbeat | 200 | 200 | PASS |
| TC-018 | Session | Expired session is rejected server-side | last_seen pushed 3 min into the past (admin limit 2) | 401 | 401 | PASS |
| TC-019 | RBAC | Supervisor blocked from POST /api/users | logged in as supervisor | 403 | 403 | PASS |
| TC-020 | RBAC | Supervisor blocked from POST /api/branches | logged in as supervisor | 403 | 403 | PASS |
| TC-021 | RBAC | Supervisor blocked from PUT /api/settings | logged in as supervisor | 403 | 403 | PASS |
| TC-022 | RBAC | Supervisor blocked from GET /api/activity | logged in as supervisor | 403 | 403 | PASS |
| TC-023 | RBAC | Supervisor blocked from DELETE /api/activity | logged in as supervisor | 403 | 403 | PASS |
| TC-024 | RBAC | Supervisor blocked from POST /api/admin/seed | logged in as supervisor | 403 | 403 | PASS |
| TC-025 | RBAC | Supervisor blocked from POST /api/admin/wipe | logged in as supervisor | 403 | 403 | PASS |
| TC-026 | RBAC | Supervisor sees only assigned branches | ravi assigned B01 only | ['B01'] | ['B01'] | PASS |
| TC-027 | RBAC | A second supervisor sees a different branch | priya assigned B02 only | ['B02'] | ['B02'] | PASS |
| TC-028 | RBAC | Admin sees every branch | admin | 2 | 2 | PASS |
| TC-029 | RBAC | Supervisor cannot write to another branch | ravi (B01) posts a worker to B02 | 403 | 403 | PASS |
| TC-030 | RBAC | Supervisor receives no user list | GET /api/bootstrap | [] | [] | PASS |
| TC-031 | RBAC | Admin receives the user list | GET /api/bootstrap | 3 | 3 | PASS |
| TC-032 | Calc engine | Broiler waste 31% -> expected meat | dressed live 82.000 kg | 56580 | 56580 | PASS |
| TC-033 | Calc engine | Waste meat = live - expected | 82.000 kg live @31% | 25420 | 25420 | PASS |
| TC-034 | Calc engine | Yield percentage | 56.000 kg meat from 82.000 kg | 68.29 | 68.29 | PASS |
| TC-035 | Calc engine | Weighted average cost across opening + purchase | 200 kg @₹120 + 205 kg @₹130 | 125.06 | 125.06 | PASS |
| TC-036 | Calc engine | Revenue sums all sale lines | skin+skinless+liver+live+cutting | 17180.0 | 17180.0 | PASS |
| TC-037 | Calc engine | Closing meat excludes liver from the pool | 5+56-30-20-1 liver-1 damage | 9000 | 9000 | PASS |
| TC-038 | Calc engine | Expected closing birds | 80+100-20 live-0 dead-40 dressed | 120 | 120 | PASS |
| TC-039 | Calc engine | Exact 69% yield produces no bonus and no shortfall | 100 kg live -> 69 kg meat | (0, 0) | (0, 0) | PASS |
| TC-040 | Calc engine | Excess meat becomes bonus | 100 kg live -> 73 kg meat | 4000 | 4000 | PASS |
| TC-041 | Calc engine | Bonus above tolerance raises the high-yield flag | 73% vs 69% ±2 | True | as expected | PASS |
| TC-042 | Calc engine | Meat below expected becomes a shortfall | 100 kg live -> 64 kg meat | 5000 | 5000 | PASS |
| TC-043 | Calc engine | Shortfall below tolerance raises the low-yield flag | 64% vs 69% ±2 | True | as expected | PASS |
| TC-044 | Calc engine | Inside tolerance raises no flag | 67% vs 69% ±2 | (False, False) | (False, False) | PASS |
| TC-045 | Calc engine | Parents waste 21% -> expected meat | 100 kg live, parents | 79000 | 79000 | PASS |
| TC-046 | Calc engine | Parents at 79% is neither bonus nor short | 100 kg -> 79 kg | (0, 0) | (0, 0) | PASS |
| TC-047 | Calc engine | Empty entry does not divide by zero | all fields absent | (0, 0.0) | (0, 0.0) | PASS |
| TC-048 | Calc engine | No purchases falls back to the opening rate | opening 200 kg @₹120, no buys | 120.0 | 120.0 | PASS |
| TC-049 | Calc engine | Several suppliers blend into one average | 200@120 + 100@100 + 100@140 | 120.0 | 120.0 | PASS |
| TC-050 | Calc engine | Purchased birds are summed across lines | 50 + 50 | 100 | 100 | PASS |
| TC-051 | Calc engine | Large volumes stay precise (50 tonnes) | 50,000 kg live @69% | 69.0 | 69.0 | PASS |
| TC-052 | Calc engine | Mortality is valued at the average cost | 20 kg dead @ the weighted average | 2501.23 | 2501.23 | PASS |
| TC-053 | Calc engine | Mortality rate as a percentage of birds handled | 10 of 180 | 5.56 | 5.56 | PASS |
| TC-054 | Calc engine | Month range spanning a year boundary | 2025-11-15 → 2026-02-03 | ['2025-11', '2025-12', '2026-01', '2026-02'] | ['2025-11', '2025-12', '2026-01', '2026-02'] | PASS |
| TC-055 | Validation | A complete entry passes | all fields present | [] | [] | PASS |
| TC-056 | Validation | Missing skin rate is caught | rateSkin = 0 | True | as expected | PASS |
| TC-057 | Validation | Missing opening weight is caught on a normal day | openWtG = 0 | True | as expected | PASS |
| TC-058 | Validation | Opening fields optional on the first ever day | openWtG = 0, first entry | True | as expected | PASS |
| TC-059 | Validation | Mortality without a photo blocks submission | mortCount = 3, photos = [] | True | as expected | PASS |
| TC-060 | Validation | Mortality with a photo passes | mortCount = 3, 1 photo | True | as expected | PASS |
| TC-061 | Validation | Supervisor is never asked for a buying rate | purchase rate = 0, role supervisor | True | as expected | PASS |
| TC-062 | Validation | Admin IS asked for the buying rate | purchase rate = 0, role admin | True | as expected | PASS |
| TC-063 | Validation | Purchase with birds but no weight is caught | birds 10, wtG 0 | True | as expected | PASS |
| TC-064 | Validation | Dressing fields optional when nothing was dressed | dressedCount = 0 | [] | [] | PASS |
| TC-065 | Validation | Costing gaps list what the admin still owes | rate 0 and openRate 0 | 2 | 2 | PASS |
| TC-066 | Validation | No gaps once rates are supplied | openRate 120, rate 130 | [] | [] | PASS |
| TC-067 | Daily entry | Supervisor submits a complete day | POST /api/entries | 201 | 201 | PASS |
| TC-068 | Daily entry | New submission is pending | status field | pending | pending | PASS |
| TC-069 | Daily entry | Supervisor's buying rate is discarded on write | supervisor sends rate 130 | 0 | 0 | PASS |
| TC-070 | Daily entry | Cost figures stripped from supervisor payload | response.calc | False | False | PASS |
| TC-071 | Daily entry | Operational figures still visible to supervisor | response.calc.yieldPct | True | as expected | PASS |
| TC-072 | Daily entry | Draft can be saved without full validation | submit flag false, sparse data | 201 | 201 | PASS |
| TC-073 | Daily entry | Duplicate branch+category+date is refused | same day twice | 409 | 409 | PASS |
| TC-074 | Daily entry | Same date but a different category is allowed | broiler and parents on one day | True | as expected | PASS |
| TC-075 | Daily entry | Incomplete submission is rejected with a field list | submit with rateSkin 0 | 422 | 422 | PASS |
| TC-076 | Daily entry | Rejection names the missing field | submit with rateSkin 0 | True | as expected | PASS |
| TC-077 | Daily entry | Failed submission leaves nothing behind | rolled back | True | as expected | PASS |
| TC-078 | Approval | Approval blocked while the buying rate is missing | POST decision approved | 422 | 422 | PASS |
| TC-079 | Approval | The response names the costing gap | gaps array | True | as expected | PASS |
| TC-080 | Approval | Approved once rates are supplied | with rates | approved | approved | PASS |
| TC-081 | Approval | Reviewer is stamped on the record | reviewedBy | True | as expected | PASS |
| TC-082 | Approval | Admin sees the weighted average after pricing | 200@120 + 205@130 | 125.06 | 125.06 | PASS |
| TC-083 | Approval | Supervisor cannot edit an approved record | PUT as supervisor | 403 | 403 | PASS |
| TC-084 | Approval | Admin can edit an approved record | PUT as admin | 57000 | 57000 | PASS |
| TC-085 | Approval | Record stays approved after an admin edit | status | approved | approved | PASS |
| TC-086 | Approval | Supervisor cannot approve anything | POST decision as supervisor | 403 | 403 | PASS |
| TC-087 | Approval | Unknown verdict is rejected | verdict='maybe' | 400 | 400 | PASS |
| TC-088 | Approval | Return sets status and stores the reason | verdict rejected | ('rejected', 'Photo unclear') | ('rejected', 'Photo unclear') | PASS |
| TC-089 | Approval | Returned entry becomes editable again for its author | PUT as supervisor | 200 | 200 | PASS |
| TC-090 | Approval | Resubmitting without an explanation is refused | submit, explanation empty | 422 | 422 | PASS |
| TC-091 | Approval | Resubmitting with an explanation succeeds | submit + explanation | pending | pending | PASS |
| TC-092 | Daily entry | Another supervisor cannot see this branch's entries | priya lists entries | 0 | 0 | PASS |
| TC-093 | Daily entry | Supervisor sees only entries they created | ravi lists entries | True | as expected | PASS |
| TC-094 | Daily entry | Date range filter works | from=2026-08-03&to=2026-08-03 | True | as expected | PASS |
| TC-095 | Daily entry | Status filter works | status=approved | True | as expected | PASS |
| TC-096 | Daily entry | Admin can delete an entry | DELETE | 200 | 200 | PASS |
| TC-097 | Daily entry | Deleting a missing entry returns 404 | DELETE bogus | 404 | 404 | PASS |
| TC-098 | Date permission | Supervisor can still edit their draft's fields | PUT notes on own draft | 200 | 200 | PASS |
| TC-099 | Date permission | Supervisor cannot move a saved entry to another date | PUT businessDate as supervisor | 403 | 403 | PASS |
| TC-100 | Date permission | The date is left untouched after the refusal | re-read the record | 2026-08-12 | 2026-08-12 | PASS |
| TC-101 | Date permission | The attempt is written to the audit log | action 'Blocked date change' | True | as expected | PASS |
| TC-102 | Date permission | A supervisor's chosen date is silently overridden to today | POST with businessDate | 2026-08-12 | 2026-08-12 | PASS |
| TC-103 | Date permission | Admin moves an entry from the approval panel | PUT /costing businessDate | 2026-07-23 | 2026-07-23 | PASS |
| TC-104 | Date permission | Admin moves it on the edit path too | PUT businessDate | 2026-07-24 | 2026-07-24 | PASS |
| TC-105 | Date permission | Admin can move and approve in one call | POST decision with businessDate | ('2026-07-25', 'approved') | ('2026-07-25', 'approved') | PASS |
| TC-106 | Date permission | The move is recorded with both dates | activity detail | True | as expected | PASS |
| TC-107 | Date permission | Moving onto an occupied day is refused | collide with an existing entry | 409 | 409 | PASS |
| TC-108 | Date permission | A malformed date is a 422, not a crash | businessDate='31-02-2026' | 422 | 422 | PASS |
| TC-109 | Date permission | Re-sending the same date changes nothing | no-op move | 200 | 200 | PASS |
| TC-110 | Photos | Entry with mortality and photos is accepted | 2 photos | 201 | 201 | PASS |
| TC-111 | Photos | Both photos are stored | photos array | 2 | 2 | PASS |
| TC-112 | Photos | Mortality without a photo is refused at the API | mortCount 1, no photos | 422 | 422 | PASS |
| TC-113 | Photos | Non-image payloads are discarded | photos=['javascript:alert(1)'] | 0 | 0 | PASS |
| TC-114 | Labour | Supervisor may add a worker | POST /api/workers | 201 | 201 | PASS |
| TC-115 | Labour | Worker without a wage is refused | dayWage 0 | 422 | 422 | PASS |
| TC-116 | Labour | Worker without a name is refused | name '' | 422 | 422 | PASS |
| TC-117 | Labour | Unicode names are preserved | name 'ರಮೇಶ್' | ರಮೇಶ್ | ರಮೇಶ್ | PASS |
| TC-118 | Labour | Supervisor cannot delete a worker | DELETE as supervisor | 403 | 403 | PASS |
| TC-119 | Attendance | Mark a full day | days=1 | 201 | 201 | PASS |
| TC-120 | Attendance | Wage equals the daily rate | 600/day | 600.0 | 600.0 | PASS |
| TC-121 | Attendance | Half day is worth half the wage | days=0.5 | 300.0 | 300.0 | PASS |
| TC-122 | Attendance | Re-marking replaces rather than duplicates | 5 marks on one day | 1 | 1 | PASS |
| TC-123 | Attendance | Marking absent removes the day | days=0 | 0 | 0 | PASS |
| TC-124 | Attendance | Eight rapid clicks stay consistent | double-click simulation | (True, 1) | (True, 1) | PASS |
| TC-125 | Attendance | Separate days accumulate | 3 different days | 3 | 3 | PASS |
| TC-126 | Payroll | Record a payment | paid ₹1000 | 201 | 201 | PASS |
| TC-127 | Payroll | Two payments on one day are allowed | second payment | 201 | 201 | PASS |
| TC-128 | Payroll | Tea is recorded | tea ₹30 | 201 | 201 | PASS |
| TC-129 | Payroll | Two teas on one day are allowed | second tea | 201 | 201 | PASS |
| TC-130 | Payroll | Zero amount is refused | paid ₹0 | 422 | 422 | PASS |
| TC-131 | Payroll | Unknown ledger type is refused | type='bribe' | 422 | 422 | PASS |
| TC-132 | Payroll | Unknown worker is refused | workerId='ghost' | 404 | 404 | PASS |
| TC-133 | Payroll | Balance = earned − paid − advances | 3 days ×600 − 1200 paid | True | as expected | PASS |
| TC-134 | Payroll | Tea and tiffin never reduce the worker balance | add ₹70 of tea | True | as expected | PASS |
| TC-135 | Payroll | Tea and tiffin DO count as a shop cost | labour_for other | True | as expected | PASS |
| TC-136 | Advances | Default day wage is 700 | settings.dayWage | 700.0 | 700.0 | PASS |
| TC-137 | Advances | Admin can change a wage after the worker exists | PUT dayWage 750 | 750.0 | 750.0 | PASS |
| TC-138 | Advances | Wages and advances are reported separately | 700 wage + 500 advance | (700.0, 500.0) | (700.0, 500.0) | PASS |
| TC-139 | Advances | Several advances on one day add up | second advance of 200 | 700.0 | 700.0 | PASS |
| TC-140 | Advances | Only wages and overheads hit the profit, never advances | net = revenue − cogs − wages − other | True | as expected | PASS |
| TC-141 | Advances | A large advance does not swing the day's profit | ₹5,000 advance on a quiet day | True | as expected | PASS |
| TC-142 | Advances | A day with no advance shows zero | different day | 0.0 | 0 | PASS |
| TC-143 | Advances | Advances stay with their own branch | B02 advance does not touch B01 | True | as expected | PASS |
| TC-144 | Advances | The advance still reduces what the worker is owed | earned − advances | True | as expected | PASS |
| TC-145 | Advances | Supervisors never see the advance figures | supervisor payload | True | as expected | PASS |
| TC-146 | Overheads | Supervisor entry starts pending | POST as supervisor | pending | pending | PASS |
| TC-147 | Overheads | Admin entry is approved immediately | POST as admin | approved | approved | PASS |
| TC-148 | Overheads | Zero amount is refused | amount 0 | 422 | 422 | PASS |
| TC-149 | Overheads | Supervisor cannot approve | POST decision as supervisor | 403 | 403 | PASS |
| TC-150 | Overheads | Admin returns one with a reason | verdict rejected | rejected | rejected | PASS |
| TC-151 | Overheads | Return reason is stored | rejectReason | Attach the bill | Attach the bill | PASS |
| TC-152 | Overheads | Admin can approve after correction | verdict approved | approved | approved | PASS |
| TC-153 | Overheads | Supervisor cannot delete an approved overhead | DELETE | 403 | 403 | PASS |
| TC-154 | Overheads | Admin can delete | DELETE as admin | 200 | 200 | PASS |
| TC-155 | Overheads | A day carries its share of the month's overheads | monthly total ÷ days in month | True | as expected | PASS |
| TC-156 | Overheads | Two categories on one day split the day's costs | broiler + parents on the same date | True | as expected | PASS |
| TC-157 | Hotel pricing | Market 250 less 50 bills at 200 | skin, less=50 | 200.0 | 200.0 | PASS |
| TC-158 | Hotel pricing | 20 kg at 200 is ₹4,000 | 20 kg skin | 4000.0 | 4000.0 | PASS |
| TC-159 | Hotel pricing | Concession is the gap against market | 50/kg over 20 kg | 1000.0 | 1000.0 | PASS |
| TC-160 | Hotel pricing | A fixed rate ignores the market | fixed 180, market 250 | 180.0 | 180.0 | PASS |
| TC-161 | Hotel pricing | A fixed rate still records the concession | fixed 180 vs market 250, 10 kg | 700.0 | 700.0 | PASS |
| TC-162 | Hotel pricing | A one-off override beats the standing deal | override 210 | 210.0 | 210.0 | PASS |
| TC-163 | Hotel pricing | A concession bigger than the market floors at zero | market 130 less 500 | 0.0 | 0.0 | PASS |
| TC-164 | Hotel pricing | No concession means they pay the counter rate | skinless, less=0 | 300.0 | 300.0 | PASS |
| TC-165 | Hotel pricing | Each product uses its own market rate | liver line | 130.0 | 130.0 | PASS |
| TC-166 | Hotel pricing | An unknown product falls back to skin, never crashes | product='wings' | skin | skin | PASS |
| TC-167 | Hotels | A supervisor may register a hotel | POST /api/customers | 201 | 201 | PASS |
| TC-168 | Hotels | The code is allocated automatically | no code supplied | H01 | H01 | PASS |
| TC-169 | Hotels | The agreed concession is stored | lessSkinless=60 | 60.0 | 60.0 | PASS |
| TC-170 | Hotels | An admin may register a hostel on a fixed rate | POST /api/customers | 201 | 201 | PASS |
| TC-171 | Hotels | Codes increment within a branch | second customer | H02 | H02 | PASS |
| TC-172 | Hotels | An opening balance is carried in | openingBalance=1500 | 1500.0 | 1500.0 | PASS |
| TC-173 | Hotels | A blank name is rejected | name='' | 422 | 422 | PASS |
| TC-174 | Hotels | A duplicate code inside a branch is refused | code=H01 again | 409 | 409 | PASS |
| TC-175 | Hotels | The same code is fine in a different branch | B02 code=H01 | 201 | 201 | PASS |
| TC-176 | Hotels | A supervisor cannot register one in another branch | ravi -> B02 | 403 | 403 | PASS |
| TC-177 | Hotels | A negative concession is rejected | lessSkin=-10 | 422 | 422 | PASS |
| TC-178 | Hotels | A non-numeric concession is a 422, not a crash | lessSkin='abc' | 422 | 422 | PASS |
| TC-179 | Hotels | An unknown kind falls back to hotel | kind='motel' | hotel | hotel | PASS |
| TC-180 | Hotel sales | Hotel lines save with the entry | 2 lines | 2 | 2 | PASS |
| TC-181 | Hotel sales | The bill uses market minus the concession | 200 − 50 over 20 kg | 3000.0 | 3000.0 | PASS |
| TC-182 | Hotel sales | The hostel's fixed rate is honoured | 220 × 5 kg | 1100.0 | 1100.0 | PASS |
| TC-183 | Hotel sales | Concession is totalled | 50×20kg + (230−220)×5kg | 1050.0 | 1050.0 | PASS |
| TC-184 | Hotel sales | Cash and account sales are split | 1 of each | [1100.0, 3000.0] | [1100.0, 3000.0] | PASS |
| TC-185 | Hotel sales | Hotel weight leaves the meat pool | open 5kg + meat 56kg − counter 31kg − hotel 25kg − damage 1kg | 4000 | 4000 | PASS |
| TC-186 | Hotel sales | Hotel money is inside revenue | counter + hotel + live + cutting | 16980.0 | 16980.0 | PASS |
| TC-187 | Hotel sales | The market rate of the day is snapshotted | skin line | 200.0 | 200.0 | PASS |
| TC-188 | Hotel sales | A line for another branch's customer is refused | B01 entry, B02 customer | 422 | 422 | PASS |
| TC-189 | Hotel sales | An unknown customer id is refused | customerId='nope' | 422 | 422 | PASS |
| TC-190 | Hotel sales | Empty rows left behind are ignored | blank line | 0 | 0 | PASS |
| TC-191 | Hotel sales | A weight with no customer blocks submission | weight but no customer | True | as expected | PASS |
| TC-192 | Hotel sales | A customer with no weight blocks submission | customer but no weight | True | as expected | PASS |
| TC-193 | Hotel sales | A line pricing to zero blocks submission | liver rate 0, less deal | True | as expected | PASS |
| TC-194 | Hotel ledger | The statement lists the sale | 1 row | 1 | 1 | PASS |
| TC-195 | Hotel ledger | An unapproved sale does not become debt | entry is pending | 0.0 | 0.0 | PASS |
| TC-196 | Hotel ledger | It is reported as pending instead | pending bucket | 3000.0 | 3000.0 | PASS |
| TC-197 | Hotel ledger | Approval turns the sale into a real balance | after approval | 3000.0 | 3000.0 | PASS |
| TC-198 | Hotel ledger | Nothing is left pending | after approval | 0.0 | 0.0 | PASS |
| TC-199 | Hotel ledger | A cash sale never touches the balance | hostel paid on the day | 1500.0 | 1500.0 | PASS |
| TC-200 | Hotel ledger | The opening balance is the starting point | opening 1500 | 1500.0 | 1500.0 | PASS |
| TC-201 | Hotel receipts | A supervisor may record a receipt | ₹1,200 cash | 201 | 201 | PASS |
| TC-202 | Hotel receipts | The balance falls by what was received | 3000 − 1200 | 1800.0 | 1800.0 | PASS |
| TC-203 | Hotel receipts | A zero receipt is rejected | amount=0 | 422 | 422 | PASS |
| TC-204 | Hotel receipts | A non-numeric amount is a 422, not a crash | amount='lots' | 422 | 422 | PASS |
| TC-205 | Hotel receipts | An unknown payment mode falls back to cash | mode='barter' | cash | cash | PASS |
| TC-206 | Hotel receipts | The running balance is carried down the statement | last row | True | as expected | PASS |
| TC-207 | Hotel receipts | A supervisor cannot delete a receipt | DELETE /api/payments | 403 | 403 | PASS |
| TC-208 | Hotels | Editing the deal does not rewrite an approved bill | approved line stays at 150 | 150.0 | 150.0 | PASS |
| TC-209 | Hotels | A draft bill picks up the new deal | 200 − 80 | 120.0 | 120.0 | PASS |
| TC-210 | Hotels | Changing the market rate reprices the draft | rateSkin 200 -> 260 | 180.0 | 180.0 | PASS |
| TC-211 | Hotel RBAC | A supervisor cannot see another branch's ledger | ravi -> B02 customer | 403 | 403 | PASS |
| TC-212 | Hotel RBAC | A supervisor cannot delete a customer | DELETE /api/customers | 403 | 403 | PASS |
| TC-213 | Hotel RBAC | Deleting a customer with history needs confirmation | no ?force | 409 | 409 | PASS |
| TC-214 | Hotel RBAC | Anonymous callers get nothing | GET /api/customers | 401 | 401 | PASS |
| TC-215 | Hotel RBAC | A supervisor sees only their own branch's customers | ravi | True | as expected | PASS |
| TC-216 | Hotel RBAC | Bootstrap carries customers and their balances | GET /api/bootstrap | True | as expected | PASS |
| TC-217 | Hotels | A customer with no history deletes cleanly | DELETE | 200 | 200 | PASS |
| TC-218 | Hotels | Forced deletion removes the ledger with it | ?force=1 | 200 | 200 | PASS |
| TC-219 | Hotels | Its sale lines go with it | cascade | 1 | 1 | PASS |
| TC-220 | Hotels | The entry itself survives the customer being removed | entry still there | 1 | 1 | PASS |
| TC-221 | Hotels | The gone customer no longer appears in the list | GET /api/customers | False | False | PASS |
| TC-222 | Live pricing | A live line prices off the LIVE rate, not skin | less=15 on a 180 market | 165.0 | 165.0 | PASS |
| TC-223 | Live pricing | The head count is carried through | 10 birds | 10 | 10 | PASS |
| TC-224 | Live pricing | A meat line never carries a head count | birds on a skin line | 0 | 0 | PASS |
| TC-225 | Functions | A function can be registered | kind=function | 201 | 201 | PASS |
| TC-226 | Functions | It is stored as its own type | kind | function | function | PASS |
| TC-227 | Functions | It carries a live-bird concession | lessLive | 15.0 | 15.0 | PASS |
| TC-228 | Functions | An unknown type still falls back to hotel | kind='party' | hotel | hotel | PASS |
| TC-229 | Live sales | The entry saves | POST /api/entries | 201 | 201 | PASS |
| TC-230 | Live sales | 60 kg at ₹165 is ₹9,900 | amount | 9900.0 | 9900.0 | PASS |
| TC-231 | Live sales | Concession is ₹15 x 60 kg | concession | 900.0 | 900.0 | PASS |
| TC-232 | Live sales | The birds come off the expected closing count | 200 opening − 30 sold | 170 | 170 | PASS |
| TC-233 | Live sales | The weight comes off the expected closing weight | 400 kg − 60 kg | 340000 | 340000 | PASS |
| TC-234 | Live sales | It does NOT touch the meat pool | opening meat 5 kg stays | 5000 | 5000 | PASS |
| TC-235 | Live sales | Live weight is reported apart from meat weight | hotelLiveG vs hotelMeatG | [60000, 0] | [60000, 0] | PASS |
| TC-236 | Live sales | The head count is totalled | hotelBirds | 30 | 30 | PASS |
| TC-237 | Live sales | A live line with no head count blocks submission | weight but no birds | True | as expected | PASS |
| TC-238 | Live sales | Meat and live on one day are kept apart | one of each | [20000, 40000] | [20000, 40000] | PASS |
| TC-239 | Overheads | A dated overhead is accepted | date supplied | 201 | 201 | PASS |
| TC-240 | Overheads | It reports itself as dated | dated flag | True | as expected | PASS |
| TC-241 | Overheads | Its month is derived from the date | period_month | 2026-08 | 2026-08 | PASS |
| TC-242 | Overheads | An undated one is not dated | month only | False | False | PASS |
| TC-243 | Overhead ledger | Branch-scoped ledger returns day rows | GET /api/overheads?branch=B01 | True | as expected | PASS |
| TC-244 | Overhead ledger | The dated ₹500 lands on its own day in full | today's row | True | as expected | PASS |
| TC-245 | Overhead ledger | A ₹3,000 monthly rent is divided across the month | 3000/31 on each day | True | as expected | PASS |
| TC-246 | Overhead ledger | Every day of the month in range carries a share | one row per day so far | 12 | 12 | PASS |
| TC-247 | Overhead ledger | It totals by branch | byBranch | True | as expected | PASS |
| TC-248 | Overhead ledger | Dated and spread are reported separately | byBranch split | True | as expected | PASS |
| TC-249 | Overhead ledger | All branches at once | no branch filter | True | as expected | PASS |
| TC-250 | Overhead ledger | A day row splits the amount per branch | today's branches | True | as expected | PASS |
| TC-251 | Overhead ledger | A supervisor sees only their own branch | ravi | True | as expected | PASS |
| TC-252 | Overhead ledger | A supervisor cannot ask for another branch | ravi -> B02 | 403 | 403 | PASS |
| TC-253 | Overheads | A dated cost hits that day's profit in full | day share includes it | True | as expected | PASS |
| TC-254 | Cash tally | Counter, live and cutting make the base | 17,180 on a clean day | 17180.0 | 17180.0 | PASS |
| TC-255 | Cash tally | With nothing else, expected equals what was sold | no credit, no payouts | 17180.0 | 17180.0 | PASS |
| TC-256 | Cash tally | Nothing declared yet | close is null | None | None | PASS |
| TC-257 | Cash tally | A supervisor cannot declare a handover, even for their own branch | priya -> B02 | 403 | 403 | PASS |
| TC-258 | Cash tally | nor for anyone else's branch | priya -> B01 | 403 | 403 | PASS |
| TC-259 | Cash tally | A supervisor has no view onto the handover screen any more | GET /api/dayclose | 403 | 403 | PASS |
| TC-260 | Cash tally | A matching handover reads as balanced | 15,000 + 2,180 | 0.0 | 0.0 | PASS |
| TC-261 | Cash tally | A thousand missing shows as short | −1,000 | -1000.0 | -1000.0 | PASS |
| TC-262 | Cash tally | An excess shows as over | +1,000 | 1000.0 | 1000.0 | PASS |
| TC-263 | Cash tally | Re-declaring updates rather than duplicating | one row per branch-day | 1 | 1 | PASS |
| TC-264 | Cash tally | Negative amounts are refused | cash=-5 | 422 | 422 | PASS |
| TC-265 | Cash tally | Text where money belongs is a 422 | cash='lots' | 422 | 422 | PASS |
| TC-266 | Cash tally | A sale on account is excluded from the expected cash | revenue > expected | True | as expected | PASS |
| TC-267 | Cash tally | The gap is exactly the credit sale | revenue − expected | 1200.0 | 1200.0 | PASS |
| TC-268 | Cash tally | An advance from the till lowers the expected handover | 17,180 − 500 | 16680.0 | 16680.0 | PASS |
| TC-269 | Cash tally | and is reported on its own line | wagesPaid | 500.0 | 500.0 | PASS |
| TC-270 | Cash history | History spans the days that traded | rows | True | as expected | PASS |
| TC-271 | Cash history | Undeclared days are flagged rather than hidden | missing flag present | True | as expected | PASS |
| TC-272 | Cash tally | A supervisor cannot verify | POST verify | 403 | 403 | PASS |
| TC-273 | Cash tally | An admin can verify | POST verify | True | as expected | PASS |
| TC-274 | Cash tally | A supervisor cannot overwrite it either, verified or not | ravi re-declares | 403 | 403 | PASS |
| TC-275 | Cash tally | An admin can reopen it | reopen | None | None | PASS |
| TC-276 | Duplicates | The first worker save succeeds | POST /api/workers | 201 | 201 | PASS |
| TC-277 | Duplicates | The same name posted twice is refused | second click | 409 | 409 | PASS |
| TC-278 | Duplicates | It points at the record that already exists | existingId | True | as expected | PASS |
| TC-279 | Duplicates | Case does not let a twin through | DOUBLE TAP | 409 | 409 | PASS |
| TC-280 | Duplicates | The same name in another branch is fine | B02 | 201 | 201 | PASS |
| TC-281 | Duplicates | Only one worker was created | count | 1 | 1 | PASS |
| TC-282 | Duplicates | The first advance is recorded | ₹500 | 201 | 201 | PASS |
| TC-283 | Duplicates | The identical one moments later is refused | double click | 409 | 409 | PASS |
| TC-284 | Duplicates | Only one ₹500 landed on the ledger | count | 1 | 1 | PASS |
| TC-285 | Duplicates | A genuine second payment can be forced through | confirmDuplicate | 201 | 201 | PASS |
| TC-286 | Duplicates | A different amount is never treated as a double click | ₹600 | 201 | 201 | PASS |
| TC-287 | Duplicates | Attendance stays one row however many times it is tapped | 3 clicks | 1 | 1 | PASS |
| TC-288 | Scale | Bootstrap query count does not grow with the number of entries | 23 queries -> 23 after +40 entries | True | as expected | PASS |
| TC-289 | Scale | and stays a small constant | under 40 queries | True | as expected | PASS |
| TC-290 | Paging | A page returns rows plus metadata | page=1&pageSize=10 | 10 | 10 | PASS |
| TC-291 | Paging | It reports the true total | total > pageSize | True | as expected | PASS |
| TC-292 | Paging | and the number of pages | pages | True | as expected | PASS |
| TC-293 | Paging | Page two is a different slice | page=2 | True | as expected | PASS |
| TC-294 | Paging | An absurd page size is capped, not obeyed | pageSize=99999 | True | as expected | PASS |
| TC-295 | Paging | A junk page number is a 422, not a crash | page=abc | 422 | 422 | PASS |
| TC-296 | Paging | Without paging params the old bare-list shape is kept | no page arg | True | as expected | PASS |
| TC-297 | Photos | A list carries the count, not the image | photoCount | 1 | 1 | PASS |
| TC-298 | Photos | and no image data at all | photos empty in list | 0 | 0 | PASS |
| TC-299 | Photos | The list says the images are not loaded | photosLoaded | False | False | PASS |
| TC-300 | Photos | They are fetched on demand | GET .../photos | 1 | 1 | PASS |
| TC-301 | Photos | and come back intact | same bytes | True | as expected | PASS |
| TC-302 | Photos | Saving without them does NOT wipe them | payload with photos:[] and no flag | 1 | 1 | PASS |
| TC-303 | Photos | Clearing them deliberately still works | photosLoaded: true with an empty list | 0 | 0 | PASS |
| TC-304 | Photos | A supervisor cannot read another branch's photos | priya -> B01 entry | 403 | 403 | PASS |
| TC-305 | Window | Bootstrap reports the window it loaded | window | True | as expected | PASS |
| TC-306 | Window | and the true total behind it | total >= loaded | True | as expected | PASS |
| TC-307 | Window | Entries older than the window are excluded but counted | 40 backdated entries | True | as expected | PASS |
| TC-308 | Window | and remain reachable by asking for the range | explicit from/to | True | as expected | PASS |
| TC-309 | Workers rename | The menu tab reads Workers, not Labour | nav tab button text | True | as expected | PASS |
| TC-310 | Auto-closing stock | A bogus client-supplied closing figure is still accepted (201) | closeBirds: 999999 in the payload | 201 | 201 | PASS |
| TC-311 | Auto-closing stock | ...but ignored — closing birds is the server's own figure | expBirds from the formula | 120 | 120 | PASS |
| TC-312 | Auto-closing stock | Closing bird weight is likewise computed | expCloseWtG | 282000 | 282000 | PASS |
| TC-313 | Auto-closing stock | Closing meat is likewise computed | expCloseMeatG | 9000 | 9000 | PASS |
| TC-314 | Auto-closing stock | With nothing left to hand-count, variance is always zero | birdVar | 0 | 0 | PASS |
| TC-315 | Auto-closing stock | An edit also ignores a bogus closing figure | stays at the computed value | 120 | 120 | PASS |
| TC-316 | Wage override | A custom day rate is accepted instead of the standard wage | wageOverride=1200, standard is 700 | 1200.0 | 1200.0 | PASS |
| TC-317 | Wage override | The worker's standing day_wage is untouched by a one-off rate | still 700 | 700.0 | 700.0 | PASS |
| TC-318 | Ledger edit | An admin can correct an already-recorded wage row | 1200 -> 1500 | 1500.0 | 1500.0 | PASS |
| TC-319 | Ledger edit | A supervisor may also correct a 'work' (wage) row | 1500 -> 1600 | 1600.0 | 1600.0 | PASS |
| TC-320 | Ledger edit | A supervisor cannot edit a 'paid' row | 403 — not a wage row | 403 | 403 | PASS |
| TC-321 | Ledger edit | An admin can edit any kind of row | 300 -> 999 | 999.0 | 999.0 | PASS |
| TC-322 | Meat reconciliation | ₹1,000 more handed over than revenue credits 5,000g of meat | +₹1000 at ₹200/kg = +5000g | 5000 | 5000 | PASS |
| TC-323 | Meat reconciliation | The entry's meat sold actually increased | skinSoldG +5000g | 35000 | 35000 | PASS |
| TC-324 | Meat reconciliation | A note explaining the adjustment is left on the entry | mentions 'extra meat sold' | True | as expected | PASS |
| TC-325 | Meat reconciliation | Re-declaring it balanced undoes the earlier credit | meatAdjustG back to 0 | 0 | 0 | PASS |
| TC-326 | Meat reconciliation | ...and the entry's meat sold reverts too | skinSoldG back to 30000 | 30000 | 30000 | PASS |
| TC-327 | Meat reconciliation | ₹800 less handed over than revenue removes 4,000g of meat | -₹800 at ₹200/kg = -4000g | -4000 | -4000 | PASS |
| TC-328 | Meat reconciliation | The entry's recorded meat sold actually decreased | skinSoldG -4000g | 26000 | 26000 | PASS |
| TC-329 | Meat reconciliation | A note explaining the shortfall is left on the entry | mentions 'reduced meat sales' | True | as expected | PASS |
| TC-330 | Meat reconciliation | The classic declared-vs-expected figure is unaffected by its own adjustment | still short by exactly ₹800 | -800.0 | -800.0 | PASS |
| TC-331 | Balance correction | A freshly added worker starts with no correction | balanceAdjustment | 0.0 | 0.0 | PASS |
| TC-332 | Balance correction | A supervisor's attempt to set it is silently ignored, not an error | 200, but unchanged | (200, 0.0) | (200, 0.0) | PASS |
| TC-333 | Balance correction | An admin can write off part of what's owed (negative) | -150 | -150.0 | -150.0 | PASS |
| TC-334 | Balance correction | ...with the reason saved alongside it | note text | Cash-box shortage on Aug 5 | Cash-box shortage on Aug 5 | PASS |
| TC-335 | Balance correction | It can also raise what's owed (positive) — 300 replaces -150, not adds | 300 | 300.0 | 300.0 | PASS |
| TC-336 | Manual closing stock | A supervisor's entry is still fully auto-computed | server's own figure, not the payload's 120 | 160 | 160 | PASS |
| TC-337 | Manual closing stock | A supervisor cannot switch closing birds to manual | stays computed, ignores closeAuto+7 | 160 | 160 | PASS |
| TC-338 | Manual closing stock | An admin CAN switch closing birds to manual and type a figure | 111 | 111 | 111 | PASS |
| TC-339 | Manual closing stock | Closing weight (still auto) ignores a bogus manual value | server's own figure | 364000 | 364000 | PASS |
| TC-340 | Manual closing stock | ...while closing birds (kept manual, value re-sent) holds at 111 | 111 | 111 | 111 | PASS |
| TC-341 | Manual closing stock | Switching back to auto recomputes it, discarding 111 | server's own figure again | 160 | 160 | PASS |
| TC-342 | Manual closing stock | Sending a value with no closeAuto flag at all is not treated as manual | still computed, ignores 555 | 160 | 160 | PASS |
| TC-343 | Today-only | A supervisor's POST date is silently overridden to today | businessDate sent D(9) | 2026-08-12 | 2026-08-12 | PASS |
| TC-344 | Today-only | An admin's POST date is left exactly as sent | businessDate sent D(600) | 2024-12-20 | 2024-12-20 | PASS |
| TC-345 | Today-only | A supervisor cannot GET another user's past-dated entry, even in their own branch | GET as ravi | 403 | 403 | PASS |
| TC-346 | Today-only | The admin's move actually lands the entry in the past | businessDate | 2026-08-03 | 2026-08-03 | PASS |
| TC-347 | Today-only | A supervisor cannot GET even their own entry once it is dated in the past | GET as priya | 403 | 403 | PASS |
| TC-348 | Today-only | A supervisor cannot PUT their own draft once it is dated in the past | PUT as priya, still draft, still theirs | 403 | 403 | PASS |
| TC-349 | Today-only | ...with the same 'locked' shape used for any other edit lock | error field | locked | locked | PASS |
| TC-350 | Today-only | The entries list never returns anything but today, any from/to range | all businessDate == today | True | as expected | PASS |
| TC-351 | Today-only | Bootstrap's entries array is today-only too | all businessDate == today | True | as expected | PASS |
| TC-352 | Today-only | ...and window.total matches what's actually loaded | total == loaded | True | as expected | PASS |
| TC-353 | Today-only | GET /api/dayclose is 403 for a supervisor | no read-only view any more | 403 | 403 | PASS |
| TC-354 | Today-only | GET /api/dayclose/history is 403 for a supervisor | same lock | 403 | 403 | PASS |
| TC-355 | Carry-forward | found is true when an approved entry exists | B01/broiler | True | as expected | PASS |
| TC-356 | Carry-forward | Closing birds match the most recent approved entry | closeBirds | 120 | 120 | PASS |
| TC-357 | Carry-forward | Closing weight matches too | closeWtG | 282000 | 282000 | PASS |
| TC-358 | Carry-forward | Closing meat matches too | closeMeatG | 10000 | 10000 | PASS |
| TC-359 | Carry-forward | The weighted average rate matches | avgRate | 125.06 | 125.06 | PASS |
| TC-360 | Carry-forward | The going sale rates carry forward too | rateSkin/rateSkinless/rateLiver/rateLive | [200.0, 230.0, 130.0, 150.0] | [200.0, 230.0, 130.0, 150.0] | PASS |
| TC-361 | Carry-forward | An admin gets the same closeBirds figure as a supervisor | ADMIN vs SUP | 120 | 120 | PASS |
| TC-362 | Carry-forward | found is false when nothing has ever been approved for that combo | B02/parents, no approvals | False | False | PASS |
| TC-363 | Today-only | A supervisor's ledger POST date is also overridden to today | date sent D(9) | 2026-08-12 | 2026-08-12 | PASS |
| TC-364 | Today-only | A supervisor cannot edit a 'work' row dated in the past | PUT as ravi | 403 | 403 | PASS |
| TC-365 | Today-only | A supervisor cannot delete a ledger row at all any more | DELETE as ravi | 403 | 403 | PASS |
| TC-366 | Overhead edit | A supervisor's dated overhead is pinned to today, not D(9) | date | 2026-08-12 | 2026-08-12 | PASS |
| TC-367 | Overhead edit | ...and they can correct it while it's still pending | 650 | 650.0 | 650.0 | PASS |
| TC-368 | Overhead edit | Another supervisor cannot touch someone else's overhead | PUT as priya | 403 | 403 | PASS |
| TC-369 | Overhead edit | Once approved, the supervisor can no longer edit it | PUT after approval | 403 | 403 | PASS |
| TC-370 | Overhead edit | An admin can still amend it after approval | PUT as admin | 700.0 | 700.0 | PASS |
| TC-371 | Overhead edit | A stale past-dated pending overhead is also out of reach | PUT as ravi | 403 | 403 | PASS |
| TC-372 | Overhead edit | ...and cannot be deleted either | DELETE as ravi | 403 | 403 | PASS |
| TC-373 | Overhead visibility | A supervisor never sees another user's overhead | admin's rent row hidden | True | as expected | PASS |
| TC-374 | Overhead visibility | ...nor their own stale past-dated one | stale D(9) row hidden | True | as expected | PASS |
| TC-375 | Day-close lock | A supervisor cannot add a ledger row once today is declared | POST /api/ledger | 403 | 403 | PASS |
| TC-376 | Day-close lock | ...nor a dated overhead for that same day | POST /api/overheads | 403 | 403 | PASS |
| TC-377 | Day-close lock | An admin is unaffected and can still add a ledger row | POST as admin | 201 | 201 | PASS |
| TC-378 | Day-close lock | A branch with no declared handover today is unaffected | POST as priya on B02 | 201 | 201 | PASS |
| TC-379 | Opening lock | A supervisor's PUT cannot change opening birds | stays as before | 120 | 120 | PASS |
| TC-380 | Opening lock | ...nor opening weight | stays as before | 282000 | 282000 | PASS |
| TC-381 | Opening lock | ...nor opening meat | stays as before | 9000 | 9000 | PASS |
| TC-382 | Opening lock | An admin's PUT can set opening birds | 999 | 999 | 999 | PASS |
| TC-383 | Opening lock | ...and opening weight | 888000 | 888000 | 888000 | PASS |
| TC-384 | Opening lock | ...and opening meat | 77000 | 77000 | 77000 | PASS |
| TC-385 | Opening lock | A supervisor's POST cannot set opening birds either | carry-forward value, not 999 | (120, 282000, 9000) | (120, 282000, 9000) | PASS |
| TC-386 | Opening lock | An admin's POST sets opening birds exactly as sent | 42 | 42 | 42 | PASS |
| TC-387 | Opening lock | ...and opening weight | 100000 | 100000 | 100000 | PASS |
| TC-388 | Opening lock | ...and opening meat | 2000 | 2000 | 2000 | PASS |
| TC-389 | Schema | A current database reports no gaps | schema_gaps() | 0 | 0 | PASS |
| TC-390 | Schema | Upgrading a current database changes nothing | upgrade_schema() | 0 | 0 | PASS |
| TC-391 | Schema | An older database is detected as behind | 4 tables + 1 column missing | True | as expected | PASS |
| TC-392 | Schema | Without the upgrade it reports 503, not a bare 500 | GET /api/bootstrap | 503 | 503 | PASS |
| TC-393 | Schema | and names the problem | error | schema_outdated | schema_outdated | PASS |
| TC-394 | Schema | and says exactly what to run | message | True | as expected | PASS |
| TC-395 | Schema | The upgrade adds the missing tables | 4 tables | True | as expected | PASS |
| TC-396 | Schema | and the missing column | overheads.spend_date | True | as expected | PASS |
| TC-397 | Schema | with nothing going wrong | problems | 0 | 0 | PASS |
| TC-398 | Schema | No gaps are left afterwards | schema_gaps() | 0 | 0 | PASS |
| TC-399 | Schema | Sign-in works once the database is upgraded | GET /api/bootstrap | 200 | 200 | PASS |
| TC-400 | Schema | The existing overhead survived untouched | ₹25,000 rent still there | 25000.0 | 25000.0 | PASS |
| TC-401 | Schema | and gained the new field as undated | dated flag | False | False | PASS |
| TC-402 | Schema | Every module answers on the upgraded database | 5 endpoints | [200, 200, 200, 200, 200] | [200, 200, 200, 200, 200] | PASS |
| TC-403 | Schema | Re-running the upgrade is a no-op | second run | 0 | 0 | PASS |
| TC-404 | Branches | Create with an explicit code | code=BX1 | BX1 | BX1 | PASS |
| TC-405 | Branches | Duplicate code is refused | code=BX1 again | 409 | 409 | PASS |
| TC-406 | Branches | Blank name is refused | name='' | 422 | 422 | PASS |
| TC-407 | Branches | Auto code is allocated when none is given | no code | True | as expected | PASS |
| TC-408 | Branches | Scales to any number (adds 15 at once, codes stay unique) | create 15 more branches | True | as expected | PASS |
| TC-409 | Branches | Rename works | PUT name | Renamed Hub | Renamed Hub | PASS |
| TC-410 | Branches | Deleting cascades to its records | DELETE BX1 | True | as expected | PASS |
| TC-411 | Branches | Cannot delete the last remaining branch | delete down to one | 409 | 409 | PASS |
| TC-412 | Users | Create a supervisor with a branch | role=supervisor | 201 | 201 | PASS |
| TC-413 | Users | Supervisor without a branch is refused | branches=[] | 422 | 422 | PASS |
| TC-414 | Users | Duplicate username is refused | username=tsup | 409 | 409 | PASS |
| TC-415 | Users | Unknown role is refused | role=owner | 422 | 422 | PASS |
| TC-416 | Users | New account can sign in | tsup/pw1234 | 200 | 200 | PASS |
| TC-417 | Users | Password reset takes effect | reset then login | 200 | 200 | PASS |
| TC-418 | Users | Too-short password is refused | pw='abc' | 422 | 422 | PASS |
| TC-419 | Users | Admin cannot delete their own account | self delete | 409 | 409 | PASS |
| TC-420 | Users | Deleted account can no longer sign in | delete tsup | 401 | 401 | PASS |
| TC-421 | Settings | Waste percentages are configurable | broiler 28% | 28.0 | 28.0 | PASS |
| TC-422 | Settings | New waste % feeds the calculation | 28% -> 72% yield | 72000 | 72000 | PASS |
| TC-423 | Settings | Restore the default | broiler 31% | 31.0 | 31.0 | PASS |
| TC-424 | Activity log | Records 'Sign in' | after the run above | True | as expected | PASS |
| TC-425 | Activity log | Records 'Failed sign in' | after the run above | True | as expected | PASS |
| TC-426 | Activity log | Records 'Submitted entry' | after the run above | True | as expected | PASS |
| TC-427 | Activity log | Records 'Approved entry' | after the run above | True | as expected | PASS |
| TC-428 | Activity log | Records 'Returned entry' | after the run above | True | as expected | PASS |
| TC-429 | Activity log | Records 'Added worker' | after the run above | True | as expected | PASS |
| TC-430 | Activity log | Records 'Created branch' | after the run above | True | as expected | PASS |
| TC-431 | Activity log | Records 'Added overhead' | after the run above | True | as expected | PASS |
| TC-432 | Activity log | Records 'Changed settings' | after the run above | True | as expected | PASS |
| TC-433 | Activity log | Records 'Created user' | after the run above | True | as expected | PASS |
| TC-434 | Activity log | Records 'Blocked: admin only' | after the run above | True | as expected | PASS |
| TC-435 | Activity log | Captures who did it | userName present | True | as expected | PASS |
| TC-436 | Activity log | Captures the role | role present | True | as expected | PASS |
| TC-437 | Activity log | Filter by action works | ?action=Sign in | True | as expected | PASS |
| TC-438 | Activity log | Supervisor cannot read it | GET as supervisor | 403 | 403 | PASS |
| TC-439 | Activity log | Blocked attempts are themselves logged | 'Blocked: admin only' | True | as expected | PASS |
| TC-440 | Robustness | Malformed JSON body does not crash | no body on login | 401 | 401 | PASS |
| TC-441 | Robustness | Missing fields default to zero | empty entry payload | 201 | 201 | PASS |
| TC-442 | Robustness | Negative weights are stored as given, not crashed | openWtG = -5000 | 201 | 201 | PASS |
| TC-443 | Robustness | Text in a numeric field is refused cleanly (422, not 500) | openBirds='abc' | 422 | 422 | PASS |
| TC-444 | Robustness | Very long note is truncated, not rejected | 3000 chars | True | as expected | PASS |
| TC-445 | Robustness | HTML in a note is stored safely as text | <script>alert(1)</script> | True | as expected | PASS |
| TC-446 | Robustness | Unknown branch code is refused | branch='ZZZ' | 403 | 403 | PASS |
| TC-447 | Robustness | Invalid category falls back to broiler | category='duck' | broiler | broiler | PASS |
| TC-448 | Robustness | A constraint breach returns 409, never 500 | duplicate day | 409 | 409 | PASS |
