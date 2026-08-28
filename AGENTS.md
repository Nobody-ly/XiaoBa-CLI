# XiaoBa-CLI Agent Instructions

## Web and account acceptance

For every web test or acceptance check that involves an account or user experience,
create a separate internal test account and run the real user flow from a real
authenticated web session. Verify page state, requests, and resulting service state,
not only mocks or direct API calls. After verification, remove the test account and
all related bots, keys, entitlements, and other test data, and clean up browser
artifacts and temporary branches. Never reuse a production user's account for
automated acceptance unless the user explicitly authorizes that specific test.

## Required account and user-experience acceptance

Any change whose acceptance involves an account, entitlement, payment, cloud worker,
or other user-facing web workflow must be tested end to end from a real authenticated
browser session. Create a separate internal test account through an approved internal
admin/API path (or seed it in the isolated test store), grant only the minimum test
entitlements, and verify the actual page state, network requests, backend records, and
resulting service state. Do not treat mocked requests, unit tests, or direct database
assertions as a substitute for the real browser flow.

After the test, remove the test account and every related bot/worker, virtual key,
provider key, quota, package entitlement, payment/test record, and other generated
data. Delete browser screenshots, traces, storage state, temporary worktrees, and
branches created for the test. Record the cleanup result and stop immediately if a
production account or resource could be affected.
