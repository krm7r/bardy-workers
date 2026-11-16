# Bardy Workers

Worker scripts extracted from the Bardy project.

## Events worker

`events/events.js` serves the Egyptian occasions database at `/events` and `/health`.
The `leeg` aggregator reads the deployed worker URL only from the `EVENTS_API_URL`
secret (the aggregator routes a root URL to `/events`). If the events worker is
protected, also set `EVENTS_API_KEY`. Do not commit either value to the repository.
