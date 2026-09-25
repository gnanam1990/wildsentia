-- Historical endpoint-only movement stays explicitly without a route.
alter table events add column if not exists movement jsonb;
