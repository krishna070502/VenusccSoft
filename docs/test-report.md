# Venus Chicken Centers — Test Report

**Run:** 2026-08-09  
**Database:** throwaway SQLite file, deleted after the run  
**Result:** 190/190 passed, 0 failed

## Summary by module

| Module | Cases | Passed | Failed |
|---|---:|---:|---:|
| Activity log | 16 | 16 | 0 |
| Approval | 14 | 14 | 0 |
| Attendance | 7 | 7 | 0 |
| Authentication | 10 | 10 | 0 |
| Branches | 8 | 8 | 0 |
| Calc engine | 23 | 23 | 0 |
| Daily entry | 17 | 17 | 0 |
| Date permission | 12 | 12 | 0 |
| Infrastructure | 4 | 4 | 0 |
| Labour | 5 | 5 | 0 |
| Overheads | 10 | 10 | 0 |
| Payroll | 10 | 10 | 0 |
| Photos | 4 | 4 | 0 |
| RBAC | 13 | 13 | 0 |
| Robustness | 9 | 9 | 0 |
| Session | 4 | 4 | 0 |
| Settings | 3 | 3 | 0 |
| Users | 9 | 9 | 0 |
| Validation | 12 | 12 | 0 |
| **Total** | **190** | **190** | **0** |

## Test cases

| # | Module | Scenario | Input / condition | Expected | Actual | Result |
|---|---|---|---|---|---|---|
| TC-001 | Infrastructure | Health endpoint reports the database | GET /healthz | ok | ok | PASS |
| TC-002 | Infrastructure | All tables created | db.create_all() | 11 | 11 | PASS |
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
| TC-094 | Daily entry | Date range filter works | from=2026-07-31&to=2026-07-31 | True | as expected | PASS |
| TC-095 | Daily entry | Status filter works | status=approved | True | as expected | PASS |
| TC-096 | Daily entry | Admin can delete an entry | DELETE | 200 | 200 | PASS |
| TC-097 | Daily entry | Deleting a missing entry returns 404 | DELETE bogus | 404 | 404 | PASS |
| TC-098 | Date permission | Supervisor can still edit their draft's fields | PUT notes on own draft | 200 | 200 | PASS |
| TC-099 | Date permission | Supervisor cannot move a saved entry to another date | PUT businessDate as supervisor | 403 | 403 | PASS |
| TC-100 | Date permission | The date is left untouched after the refusal | re-read the record | 2026-07-19 | 2026-07-19 | PASS |
| TC-101 | Date permission | The attempt is written to the audit log | action 'Blocked date change' | True | as expected | PASS |
| TC-102 | Date permission | Supervisor still chooses the date when creating | POST with businessDate | 2026-07-18 | 2026-07-18 | PASS |
| TC-103 | Date permission | Admin moves an entry from the approval panel | PUT /costing businessDate | 2026-07-20 | 2026-07-20 | PASS |
| TC-104 | Date permission | Admin moves it on the edit path too | PUT businessDate | 2026-07-21 | 2026-07-21 | PASS |
| TC-105 | Date permission | Admin can move and approve in one call | POST decision with businessDate | ('2026-07-22', 'approved') | ('2026-07-22', 'approved') | PASS |
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
| TC-136 | Overheads | Supervisor entry starts pending | POST as supervisor | pending | pending | PASS |
| TC-137 | Overheads | Admin entry is approved immediately | POST as admin | approved | approved | PASS |
| TC-138 | Overheads | Zero amount is refused | amount 0 | 422 | 422 | PASS |
| TC-139 | Overheads | Supervisor cannot approve | POST decision as supervisor | 403 | 403 | PASS |
| TC-140 | Overheads | Admin returns one with a reason | verdict rejected | rejected | rejected | PASS |
| TC-141 | Overheads | Return reason is stored | rejectReason | Attach the bill | Attach the bill | PASS |
| TC-142 | Overheads | Admin can approve after correction | verdict approved | approved | approved | PASS |
| TC-143 | Overheads | Supervisor cannot delete an approved overhead | DELETE | 403 | 403 | PASS |
| TC-144 | Overheads | Admin can delete | DELETE as admin | 200 | 200 | PASS |
| TC-145 | Overheads | Overheads never touch a day's profit | compare entry netProfit with and without overheads | True | as expected | PASS |
| TC-146 | Branches | Create with an explicit code | code=BX1 | BX1 | BX1 | PASS |
| TC-147 | Branches | Duplicate code is refused | code=BX1 again | 409 | 409 | PASS |
| TC-148 | Branches | Blank name is refused | name='' | 422 | 422 | PASS |
| TC-149 | Branches | Auto code is allocated when none is given | no code | True | as expected | PASS |
| TC-150 | Branches | Scales to any number (adds 15 at once, codes stay unique) | create 15 more branches | True | as expected | PASS |
| TC-151 | Branches | Rename works | PUT name | Renamed Hub | Renamed Hub | PASS |
| TC-152 | Branches | Deleting cascades to its records | DELETE BX1 | True | as expected | PASS |
| TC-153 | Branches | Cannot delete the last remaining branch | delete down to one | 409 | 409 | PASS |
| TC-154 | Users | Create a supervisor with a branch | role=supervisor | 201 | 201 | PASS |
| TC-155 | Users | Supervisor without a branch is refused | branches=[] | 422 | 422 | PASS |
| TC-156 | Users | Duplicate username is refused | username=tsup | 409 | 409 | PASS |
| TC-157 | Users | Unknown role is refused | role=owner | 422 | 422 | PASS |
| TC-158 | Users | New account can sign in | tsup/pw1234 | 200 | 200 | PASS |
| TC-159 | Users | Password reset takes effect | reset then login | 200 | 200 | PASS |
| TC-160 | Users | Too-short password is refused | pw='abc' | 422 | 422 | PASS |
| TC-161 | Users | Admin cannot delete their own account | self delete | 409 | 409 | PASS |
| TC-162 | Users | Deleted account can no longer sign in | delete tsup | 401 | 401 | PASS |
| TC-163 | Settings | Waste percentages are configurable | broiler 28% | 28.0 | 28.0 | PASS |
| TC-164 | Settings | New waste % feeds the calculation | 28% -> 72% yield | 72000 | 72000 | PASS |
| TC-165 | Settings | Restore the default | broiler 31% | 31.0 | 31.0 | PASS |
| TC-166 | Activity log | Records 'Sign in' | after the run above | True | as expected | PASS |
| TC-167 | Activity log | Records 'Failed sign in' | after the run above | True | as expected | PASS |
| TC-168 | Activity log | Records 'Submitted entry' | after the run above | True | as expected | PASS |
| TC-169 | Activity log | Records 'Approved entry' | after the run above | True | as expected | PASS |
| TC-170 | Activity log | Records 'Returned entry' | after the run above | True | as expected | PASS |
| TC-171 | Activity log | Records 'Added worker' | after the run above | True | as expected | PASS |
| TC-172 | Activity log | Records 'Created branch' | after the run above | True | as expected | PASS |
| TC-173 | Activity log | Records 'Added overhead' | after the run above | True | as expected | PASS |
| TC-174 | Activity log | Records 'Changed settings' | after the run above | True | as expected | PASS |
| TC-175 | Activity log | Records 'Created user' | after the run above | True | as expected | PASS |
| TC-176 | Activity log | Records 'Blocked: admin only' | after the run above | True | as expected | PASS |
| TC-177 | Activity log | Captures who did it | userName present | True | as expected | PASS |
| TC-178 | Activity log | Captures the role | role present | True | as expected | PASS |
| TC-179 | Activity log | Filter by action works | ?action=Sign in | True | as expected | PASS |
| TC-180 | Activity log | Supervisor cannot read it | GET as supervisor | 403 | 403 | PASS |
| TC-181 | Activity log | Blocked attempts are themselves logged | 'Blocked: admin only' | True | as expected | PASS |
| TC-182 | Robustness | Malformed JSON body does not crash | no body on login | 401 | 401 | PASS |
| TC-183 | Robustness | Missing fields default to zero | empty entry payload | 201 | 201 | PASS |
| TC-184 | Robustness | Negative weights are stored as given, not crashed | openWtG = -5000 | 201 | 201 | PASS |
| TC-185 | Robustness | Text in a numeric field is refused cleanly (422, not 500) | openBirds='abc' | 422 | 422 | PASS |
| TC-186 | Robustness | Very long note is truncated, not rejected | 3000 chars | True | as expected | PASS |
| TC-187 | Robustness | HTML in a note is stored safely as text | <script>alert(1)</script> | True | as expected | PASS |
| TC-188 | Robustness | Unknown branch code is refused | branch='ZZZ' | 403 | 403 | PASS |
| TC-189 | Robustness | Invalid category falls back to broiler | category='duck' | broiler | broiler | PASS |
| TC-190 | Robustness | A constraint breach returns 409, never 500 | duplicate day | 409 | 409 | PASS |
