# XiaoBa-CLI Agent Instructions

## Web and account acceptance

For every web test or acceptance check that involves an account or user experience,
create a separate internal test account and run the real user flow from a real
authenticated web session. Verify page state, requests, and resulting service state,
not only mocks or direct API calls. After verification, remove the test account and
all related bots, keys, entitlements, and other test data, and clean up browser
artifacts and temporary branches. Never reuse a production user's account for
automated acceptance unless the user explicitly authorizes that specific test.
