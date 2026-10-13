-- Congo 1C review: a sale names the asset it sold, so a replayed key is honoured only for that sale.
alter table sim_purchases add column asset_id uuid references animal_assets(asset_id);
